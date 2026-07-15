import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'ui_parser.dart';
import 'platform_renderer.dart';

// ── 3D 设备实例 (自包含, 不依赖未完成的 three_d 模块) ──
class DeviceInstance {
  final String id;
  final String modelKey;
  final double xRatio;
  final double yRatio;
  final double rotationX;
  final double rotationY;
  final double rotationZ;
  final double displayScale;
  final bool isSelected;

  const DeviceInstance({
    required this.id,
    required this.modelKey,
    this.xRatio = 0.5,
    this.yRatio = 0.5,
    this.rotationX = 0,
    this.rotationY = 0,
    this.rotationZ = 0,
    this.displayScale = 1.0,
    this.isSelected = false,
  });

  DeviceInstance copyWith({
    double? xRatio, double? yRatio,
    double? rotationX, double? rotationY, double? rotationZ,
    double? displayScale, bool? isSelected,
  }) => DeviceInstance(
    id: id, modelKey: modelKey,
    xRatio: xRatio ?? this.xRatio,
    yRatio: yRatio ?? this.yRatio,
    rotationX: rotationX ?? this.rotationX,
    rotationY: rotationY ?? this.rotationY,
    rotationZ: rotationZ ?? this.rotationZ,
    displayScale: displayScale ?? this.displayScale,
    isSelected: isSelected ?? this.isSelected,
  );
}

// ── 根据 modelKey 前缀判定设备 group ──
String _groupOf(String modelKey) {
  if (modelKey.startsWith('m-')) return 'mobile';
  if (modelKey.startsWith('t-')) return 'tablet';
  if (modelKey.startsWith('w-')) return 'watch';
  return 'desktop';
}

// Lazy load user32 符号 — 在 release AOT 中顶层 DynamicLibrary.open 可能触发
// native stack guard。延迟到第一次 WindowConfig.init() 调用。
DynamicLibrary? _user32Lib;
int Function(int, int)? _getWindowLongPtrW;
int Function(int, int, int)? _setWindowLongPtrW;
int Function(int, int)? _setParent;
int Function(int, int, int, int, int, int, int)? _setWindowPos;
int Function()? _getActiveWindow;

void _ensureUser32() {
  if (_user32Lib != null) return;
  _user32Lib = DynamicLibrary.open('user32.dll');
  _getWindowLongPtrW = _user32Lib!.lookupFunction<
      IntPtr Function(IntPtr, Int32),
      int Function(int, int)
    >('GetWindowLongPtrW');
  _setWindowLongPtrW = _user32Lib!.lookupFunction<
      IntPtr Function(IntPtr, Int32, IntPtr),
      int Function(int, int, int)
    >('SetWindowLongPtrW');
  _setParent = _user32Lib!.lookupFunction<
      IntPtr Function(IntPtr, IntPtr),
      int Function(int, int)
    >('SetParent');
  _setWindowPos = _user32Lib!.lookupFunction<
      Int32 Function(IntPtr, IntPtr, Int32, Int32, Int32, Int32, Int32),
      int Function(int, int, int, int, int, int, int)
    >('SetWindowPos');
  _getActiveWindow = _user32Lib!.lookupFunction<
      IntPtr Function(),
      int Function()
    >('GetActiveWindow');
}

const int _gwlStyle = -16;
const int _wsChild = 0x40000000;
const int _wsVisible = 0x10000000;
const int _wsCaption = 0x00C00000;
const int _wsThickFrame = 0x00040000;
const int _wsMinimizeBox = 0x00020000;
const int _wsMaximizeBox = 0x00010000;
const int _wsSysMenu = 0x00080000;
const int _wsPopup = 0x80000000;
const int _swpFrameChanged = 0x0020;
const int _swpNoMove = 0x0002;
const int _swpNoSize = 0x0001;
const int _swpNoZOrder = 0x0004;
const int _swpShowWindow = 0x0040;

void main(List<String> args) {
  WidgetsFlutterBinding.ensureInitialized();

  // 命令行参数: 来自 C++ 入口 project.set_dart_entrypoint_arguments(std::move(args))
  // 注意: Windows 下 Platform.executableArguments 在 AOT 模式下行为不一致，统一从 main() 参数拿
  if (args.isEmpty) {
    // 兜底：env var FLUTTER_ARGS（开发态 flutter run 用）
    args = List<String>.from(Platform.environment['FLUTTER_ARGS']?.split(' ') ?? const <String>[]);
  }

  int port = 9090;
  int? parentHwnd;
  String? modelsDir;

  for (int i = 0; i < args.length; i++) {
    final a = args[i];
    if (a == '--port' && i + 1 < args.length) {
      port = int.tryParse(args[i + 1]) ?? 9090;
      i++;
    } else if (a.startsWith('--port=')) {
      port = int.tryParse(a.substring(7)) ?? 9090;
    } else if (a == '--parent-hwnd' && i + 1 < args.length) {
      parentHwnd = int.tryParse(args[i + 1]);
      i++;
    } else if (a.startsWith('--parent-hwnd=')) {
      parentHwnd = int.tryParse(a.substring('--parent-hwnd='.length));
    } else if (a == '--models-dir' && i + 1 < args.length) {
      modelsDir = args[i + 1];
      i++;
    } else if (a.startsWith('--models-dir=')) {
      modelsDir = a.substring('--models-dir='.length);
    }
  }

  _writeLog('[main] started port=$port parentHwnd=$parentHwnd modelsDir=$modelsDir args=${args.join(" ")}');

  runApp(CanvasApp(port: port, parentHwnd: parentHwnd, modelsDir: modelsDir));
}

void _writeLog(String msg) {
  try {
    final logFile = File('${Platform.environment['TEMP'] ?? '.'}\\soloforge_canvas.log');
    logFile.writeAsStringSync(
      '${DateTime.now().toIso8601String()} $msg\n',
      mode: FileMode.append,
      flush: true,
    );
  } catch (_) {}
}

class CanvasApp extends StatefulWidget {
  final int port;
  final int? parentHwnd;
  final String? modelsDir;

  const CanvasApp({super.key, required this.port, this.parentHwnd, this.modelsDir});

  @override
  State<CanvasApp> createState() => _CanvasAppState();
}

class _CanvasAppState extends State<CanvasApp> {
  HttpServer? _httpServer;
  UiNode? _uiNode;
  String _renderMode = 'material';

  // ── 3D 设备状态: 当前活跃 session 的设备列表 ──
  final Map<String, DeviceInstance> _devices = {};
  String? _activeSessionId;

  // ── 3D 模型查看器: 当前加载的 GLB 文件路径 (相对 modelsDir) ──
  String? _currentGlbPath;
  InAppWebViewController? _webviewController;
  StreamSubscription<FileSystemEvent>? _modelWatcher;
  // model-viewer 加载重试计数 (文件刚放入时可能还没写完)
  int _loadRetry = 0;
  // ★ 预加载的 model-viewer.min.js 内容 (内联到 HTML, 避免跨域加载问题)
  String? _modelViewerJs;
  // ★ 查看模式: false=设计模式(固定正面, 显示2D UI), true=查看模式(可旋转, 隐藏2D UI)
  bool _viewMode = false;

  // ── 2026-07-08 修复: 防止画布进程崩溃 ──────────────────────────
  //
  // 根因: 原来的 `await for (final request in _httpServer!)` 串行处理
  //   每个请求, 流式推送期间 50ms 间隔的 POST /render 请求堆积,
  //   导致 Dart 事件循环饿死 → 进程崩溃 (exit code 如 104060)。
  //
  // 修复:
  //   1. 并发处理: 用 .listen() 替代 await for, 每个请求独立 async
  //   2. WebSocket 清理: 跟踪所有活跃连接, dispose 时关闭
  //   3. 健康检查: /health 端点供主进程看门狗心跳
  //   4. setState 节流: 最快 100ms 一次, 防止 Flutter rebuild 队列爆炸
  //   5. 请求体限制: 拒绝 > 10MB 的 payload
  //   6. 服务器空闲超时: 30s 无活动自动断开空闲连接
  //   7. 错误日志: 写入 soloforge_canvas.log 供诊断
  // ────────────────────────────────────────────────────────────────

  final Set<WebSocket> _activeWebSockets = {};
  Timer? _setStateTimer;
  String? _pendingMode;
  Map<String, dynamic>? _pendingUiData;
  bool _setStateScheduled = false;

  @override
  void initState() {
    super.initState();
    _configureWindow();
    _startServer();
    _preloadModelViewerJs();
  }

  /// ★ 预加载 model-viewer.min.js 内容到内存
  ///   后续 _buildModelViewer 把它内联到 HTML 的 <script> 标签里
  ///   避免 WebView 跨域加载 module script 的问题
  Future<void> _preloadModelViewerJs() async {
    try {
      final data = await rootBundle.load('assets/model-viewer.min.js');
      _modelViewerJs = String.fromCharCodes(
        data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
      _writeLog('[assets] model-viewer.min.js loaded: ${_modelViewerJs!.length} chars');
    } catch (e) {
      _writeLog('[assets] failed to load model-viewer.min.js: $e');
    }
  }

  void _configureWindow() {
    // 暂时禁用 FFI 调用 — release 模式 STATUS_STACK_BUFFER_OVERRUN 排查中
    // SetParent 嵌入逻辑由主进程侧通过 PowerShell 完成
    try {
      _writeLog('[configure] skipped (FFI disabled for release stability)');
    } catch (_) {}
    return;
  }

  Future<void> _startServer() async {
    try {
      _httpServer = await HttpServer.bind('127.0.0.1', widget.port);
      // 30s 空闲超时: 防止僵死连接占用资源
      _httpServer!.idleTimeout = const Duration(seconds: 30);
      _writeLog('[server] listening on port ${widget.port}');

      // ★ 关键修复: 用 .listen() 替代 `await for` 实现并发处理
      //   await for 是串行的: 一个请求处理完才能拿下一个
      //   .listen() 回调立即返回, 每个请求在独立 async 函数中处理
      _httpServer!.listen(
        (HttpRequest request) {
          _handleRequest(request);
        },
        onError: (e) {
          _writeLog('[server] error: $e');
        },
        cancelOnError: false,
      );
    } catch (e) {
      _writeLog('[server] bind failed: $e');
    }
  }

  /// ★ 3D 模型文件服务: 从 modelsDir 读取 GLB 文件返回给 WebView
  Future<void> _handleModelFile(HttpRequest request, String path) async {
    try {
      final baseDir = widget.modelsDir;
      if (baseDir == null) {
        request.response.statusCode = 404;
        await request.response.close();
        return;
      }
      // /models/3d/mobile/xxx.glb → baseDir/3d/mobile/xxx.glb
      final relativePath = path.substring('/models/'.length);
      final filePath = '$baseDir/$relativePath';
      final file = File(filePath);
      if (!await file.exists()) {
        _writeLog('[models] file not found: $filePath');
        request.response.statusCode = 404;
        await request.response.close();
        return;
      }
      // 根据扩展名设置 Content-Type
      if (filePath.endsWith('.glb')) {
        request.response.headers.contentType = ContentType.parse('model/gltf-binary');
      } else if (filePath.endsWith('.gltf')) {
        request.response.headers.contentType = ContentType.parse('model/gltf+json');
      } else {
        request.response.headers.contentType = ContentType.binary;
      }
      // 允许跨域 (WebView file:// 协议需要)
      request.response.headers.add('Access-Control-Allow-Origin', '*');
      await file.openRead().pipe(request.response);
    } catch (e) {
      _writeLog('[models] serve error: $e');
      try {
        request.response.statusCode = 500;
        await request.response.close();
      } catch (_) {}
    }
  }

  /// ★ 离线 assets 服务: 从 Flutter asset bundle 读取文件返回给 WebView
  ///
  /// 用途: WebView 里的 HTML 通过 <script src="/assets/model-viewer.min.js">
  ///      加载本地的 model-viewer web component, 避免依赖 CDN
  Future<void> _handleAssetFile(HttpRequest request, String path) async {
    try {
      // /assets/model-viewer.min.js → assets/model-viewer.min.js
      final assetKey = path.substring(1); // 去掉前导 /

      // ★ 优先用预加载的 _modelViewerJs (内存), 避免 rootBundle 异步延迟
      final cached = _modelViewerJs;
      if (assetKey == 'assets/model-viewer.min.js' && cached != null && cached.isNotEmpty) {
        request.response.headers.contentType =
          ContentType.parse('application/javascript');
        request.response.headers.add('Access-Control-Allow-Origin', '*');
        request.response.add(utf8.encode(cached));
        await request.response.close();
        return;
      }

      // 兜底: 从 asset bundle 读取
      final byteData = await rootBundle.load(assetKey);
      final bytes = byteData.buffer.asUint8List(
        byteData.offsetInBytes, byteData.lengthInBytes);

      // 根据扩展名设置 Content-Type
      if (assetKey.endsWith('.js')) {
        request.response.headers.contentType =
          ContentType.parse('application/javascript');
      } else if (assetKey.endsWith('.css')) {
        request.response.headers.contentType = ContentType.text;
      } else if (assetKey.endsWith('.html')) {
        request.response.headers.contentType = ContentType.html;
      } else {
        request.response.headers.contentType = ContentType.binary;
      }
      request.response.headers.add('Access-Control-Allow-Origin', '*');
      request.response.add(bytes);
      await request.response.close();
    } catch (e) {
      _writeLog('[assets] serve error: $e (path=$path)');
      try {
        request.response.statusCode = 404;
        await request.response.close();
      } catch (_) {}
    }
  }


  Future<void> _handleRequest(HttpRequest request) async {
    try {
      final path = request.uri.path;

      if (path == '/health') {
        // 健康检查端点: 主进程看门狗用
        request.response.statusCode = 200;
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode({
          'ok': true,
          'uptime': DateTime.now().millisecondsSinceEpoch,
          'websockets': _activeWebSockets.length,
        }));
        await request.response.close();
        return;
      }

      if (path == '/ws' || path == '/') {
        // WebSocket 升级 — 跟踪连接生命周期
        try {
          final channel = await WebSocketTransformer.upgrade(request);
          _activeWebSockets.add(channel);
          channel.listen(
            (dynamic data) {
              if (data is String) {
                _handleMessage(data);
              }
            },
            onError: (e) {
              _writeLog('[ws] error: $e');
            },
            onDone: () {
              // ★ 关键: 连接关闭时从 Set 中移除, 释放资源
              _activeWebSockets.remove(channel);
            },
            cancelOnError: false,
          );
        } catch (e) {
          _writeLog('[ws] upgrade failed: $e');
        }
        return;
      }

      // ★ 3D 模型静态文件服务: /models/3d/... → modelsDir/3d/...
      //    InAppWebView 里的 model-viewer 通过 http://127.0.0.1:port/models/3d/xxx.glb 加载 GLB
      if (request.method == 'GET' && path.startsWith('/models/')) {
        await _handleModelFile(request, path);
        return;
      }

      // ★ 离线 assets 服务: /assets/xxx → Flutter asset bundle
      //    用于 WebView 加载 model-viewer.min.js (离线, 不依赖 CDN)
      if (request.method == 'GET' && path.startsWith('/assets/')) {
        await _handleAssetFile(request, path);
        return;
      }

      if (request.method == 'POST' && path == '/render') {
        await _handleHttpRender(request);
        return;
      }

      // 未知路径: 返回 404 (Canvas3DClient 的 /push-ui 等端点会走到这里)
      request.response.statusCode = 404;
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode({'ok': false, 'error': 'not found'}));
      await request.response.close();
    } catch (e) {
      _writeLog('[server] request handler error: $e');
      try {
        request.response.statusCode = 500;
        await request.response.close();
      } catch (_) {}
    }
  }

  Future<void> _handleHttpRender(HttpRequest request) async {
    try {
      // ★ 请求体大小限制: 防止超大 payload 导致 OOM
      final contentLength = request.contentLength;
      if (contentLength > 10 * 1024 * 1024) {
        request.response.statusCode = 413;
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode({'ok': false, 'error': 'payload too large (max 10MB)' }));
        await request.response.close();
        return;
      }

      final body = await utf8.decoder.bind(request).join();
      _handleMessage(body);
      request.response.statusCode = 200;
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode({ 'ok': true }));
    } catch (e) {
      _writeLog('[render] error: $e');
      request.response.statusCode = 400;
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode({ 'ok': false, 'error': e.toString() }));
    } finally {
      await request.response.close();
    }
  }

  void _handleMessage(String message) {
    try {
      final data = jsonDecode(message) as Map<String, dynamic>;

      // ★ 3D 设备相关 action (selectDevice / clearDevices / transformDevice)
      //   优先处理, 处理完直接 return (不走 UI 渲染路径)
      if (data.containsKey('action')) {
        final action = data['action'] as String;
        _handleDeviceAction(action, data);
        return;
      }

      String? mode;
      Map<String, dynamic>? uiData;

      // platform 字段直接作为 mode（'material' / 'fluent' / 'chart'）
      if (data.containsKey('platform')) {
        mode = data['platform'] as String;
      } else if (data.containsKey('mode')) {
        mode = data['mode'] as String;
      }
      if (data.containsKey('ui')) {
        uiData = data['ui'] as Map<String, dynamic>;
      } else if (data.containsKey('type')) {
        uiData = data;
      }

      if (mode != null || uiData != null) {
        // ★ 节流 setState: 最快 100ms 一次 (10fps)
        //   流式推送 50ms 间隔时, 跳过中间帧只渲染最新
        //   防止 Flutter rebuild 队列堆积 → 内存增长 → 崩溃
        _pendingMode = mode ?? _pendingMode;
        _pendingUiData = uiData ?? _pendingUiData;

        if (!_setStateScheduled) {
          _setStateScheduled = true;
          _setStateTimer?.cancel();
          _setStateTimer = Timer(const Duration(milliseconds: 100), () {
            _setStateScheduled = false;
            if (!mounted) return;
            setState(() {
              if (_pendingMode != null) _renderMode = _pendingMode!;
              if (_pendingUiData != null) _uiNode = UiParser.parse(_pendingUiData!);
              _pendingMode = null;
              _pendingUiData = null;
            });
          });
        }
      }
    } catch (e) {
      _writeLog('[message] parse error: $e');
    }
  }

  /// ★ 3D 设备 action 处理 (自包含, 不依赖 three_d 模块)
  void _handleDeviceAction(String action, Map<String, dynamic> data) {
    switch (action) {
      case 'selectDevice':
        final modelKey = data['modelKey'] as String?;
        if (modelKey == null) return;
        // 'fill' / 'none' = 2D 模式标记
        if (modelKey == 'fill' || modelKey == 'none') {
          setState(() {
            _renderMode = 'material';
            _devices.clear();
            _nativeSizes.clear();
            _currentGlbPath = null;
            _viewMode = false; // ★ 切回 2D 时重置查看模式
          });
          _stopModelWatcher();
          // ★ FIX: 置空 _webviewController, 避免悬空引用 (WebView 已被 Flutter dispose)
          _webviewController = null;
          _writeLog('[device] switch to 2D fill mode');
          break;
        }
        // 解析 nativeSize {w, h} 和 file (GLB 路径)
        final ns = data['nativeSize'] as Map<String, dynamic>?;
        final nw = (ns?['w'] as num?)?.toDouble() ?? 0;
        final nh = (ns?['h'] as num?)?.toDouble() ?? 0;
        final glbFile = data['file'] as String?; // 如 "mobile/iphone_14_pro.glb"
        final deviceId = 'dev-$modelKey';
        setState(() {
          _renderMode = '3d';
          _devices.clear();
          _devices[deviceId] = DeviceInstance(
            id: deviceId,
            modelKey: modelKey,
            xRatio: 0.5,
            yRatio: 0.5,
            displayScale: 1.0,
            isSelected: true,
          );
          _nativeSizes[deviceId] = (nw, nh);
          // ★ 不清除 _uiNode — 保留 2D UI 内容, 在 3D 模型屏幕区域内显示
          // ★ 设置当前 GLB 路径, _buildDevice3DScene 据此加载 model-viewer
          _currentGlbPath = glbFile;
          _loadRetry = 0;
        });
        // ★ 启动热加载监听 (监听 models/3d 目录)
        _startModelWatcher(glbFile);
        _writeLog('[device] select: $modelKey glb=$glbFile native=${nw}x${nh}');
        break;

      case 'transformDevice':
        final deviceId = data['deviceId'] as String?;
        final transform = data['transform'] as Map<String, dynamic>?;
        if (deviceId != null && transform != null) {
          _applyDeviceTransform(deviceId, transform);
        }
        break;

      case 'clearDevices':
        // ★ FIX: 补齐资源清理 (与 selectDevice fill/none 分支对齐)
        //   避免 _modelWatcher 泄漏 + _webviewController 悬空引用
        setState(() {
          _renderMode = 'material';
          _devices.clear();
          _nativeSizes.clear();
          _currentGlbPath = null;
          _viewMode = false;
        });
        _stopModelWatcher();
        _webviewController = null;
        _writeLog('[device] cleared all');
        break;
    }
  }

  /// 设备 nativeSize 缓存: deviceId -> (width, height)
  final Map<String, (double, double)> _nativeSizes = {};

  /// 应用设备 transform 变化
  void _applyDeviceTransform(String deviceId, Map<String, dynamic> transform) {
    final old = _devices[deviceId];
    if (old == null) {
      final modelKey = (transform['modelKey'] as String?) ?? 'unknown';
      _devices[deviceId] = DeviceInstance(
        id: deviceId,
        modelKey: modelKey,
        xRatio: (transform['xRatio'] as num?)?.toDouble() ?? 0.5,
        yRatio: (transform['yRatio'] as num?)?.toDouble() ?? 0.5,
        rotationX: (transform['rotationX'] as num?)?.toDouble() ?? 0,
        rotationY: (transform['rotationY'] as num?)?.toDouble() ?? 0,
        rotationZ: (transform['rotationZ'] as num?)?.toDouble() ?? 0,
        displayScale: (transform['displayScale'] as num?)?.toDouble() ?? 1.0,
        isSelected: (transform['isSelected'] as bool?) ?? false,
      );
    } else {
      _devices[deviceId] = old.copyWith(
        xRatio: (transform['xRatio'] as num?)?.toDouble() ?? old.xRatio,
        yRatio: (transform['yRatio'] as num?)?.toDouble() ?? old.yRatio,
        rotationX: (transform['rotationX'] as num?)?.toDouble() ?? old.rotationX,
        rotationY: (transform['rotationY'] as num?)?.toDouble() ?? old.rotationY,
        rotationZ: (transform['rotationZ'] as num?)?.toDouble() ?? old.rotationZ,
        displayScale: (transform['displayScale'] as num?)?.toDouble() ?? old.displayScale,
        isSelected: (transform['isSelected'] as bool?) ?? old.isSelected,
      );
    }
    setState(() {});
  }

  // ── 3D 模型热加载: 监听 models/3d 目录变化 ──────────────────

  /// 启动文件监听: 当 GLB 文件被放入目录时自动重新加载
  void _startModelWatcher(String? glbFile) {
    _stopModelWatcher();
    if (glbFile == null || widget.modelsDir == null) return;
    final watchDir = '${widget.modelsDir}/3d';
    try {
      final dir = Directory(watchDir);
      if (!dir.existsSync()) {
        _writeLog('[watcher] dir not found: $watchDir, will poll');
        // 目录不存在时用轮询 (用户可能稍后创建)
        _startPollWatcher(glbFile);
        return;
      }
      _modelWatcher = dir.watch(recursive: true).listen((event) {
        final path = event.path.replaceAll('\\', '/');
        // 只关心当前设备的 GLB 文件变化
        if (glbFile != null && path.endsWith(glbFile)) {
          _writeLog('[watcher] file changed: $path, reloading...');
          _reloadModel();
        }
      });
      _writeLog('[watcher] watching $watchDir for $glbFile');
    } catch (e) {
      _writeLog('[watcher] watch failed: $e, fallback to poll');
      _startPollWatcher(glbFile);
    }
  }

  /// 轮询兜底 (watch 在某些文件系统上不可靠)
  Timer? _pollTimer;
  void _startPollWatcher(String? glbFile) {
    _pollTimer?.cancel();
    if (glbFile == null || widget.modelsDir == null) return;
    _pollTimer = Timer.periodic(const Duration(seconds: 2), (_) {
      _checkAndReload(glbFile);
    });
  }

  void _checkAndReload(String glbFile) {
    final filePath = '${widget.modelsDir}/3d/$glbFile';
    final file = File(filePath);
    if (file.existsSync()) {
      _writeLog('[poll] file detected: $filePath, reloading...');
      _pollTimer?.cancel();
      _pollTimer = null;
      _reloadModel();
    }
  }

  /// 重新加载 model-viewer (通过 JS 切换 src)
  void _reloadModel() {
    final ctrl = _webviewController;
    final glbPath = _currentGlbPath;
    if (ctrl == null || glbPath == null) return;
    final url = 'http://127.0.0.1:${widget.port}/models/3d/$glbPath';
    // 通过 JS 更新 model-viewer 的 src 属性触发重新加载
    // ★ FIX: 加 catchError, 避免对已 dispose 的 WebView 调用时抛未捕获异常
    ctrl.evaluateJavascript(source: '''
      const mv = document.querySelector('model-viewer');
      if (mv) {
        mv.src = "$url?t=${DateTime.now().millisecondsSinceEpoch}";
      }
    ''').catchError((e) {
      _writeLog('[reload] evaluateJavascript error (webview disposed?): $e');
    });
    _writeLog('[reload] model-viewer src updated: $url');
  }

  void _stopModelWatcher() {
    _modelWatcher?.cancel();
    _modelWatcher = null;
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  @override
  void dispose() {
    _setStateTimer?.cancel();
    _stopModelWatcher();
    // 关闭所有 WebSocket 连接
    for (final ws in _activeWebSockets) {
      try { ws.close(); } catch (_) {}
    }
    _activeWebSockets.clear();
    _httpServer?.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        backgroundColor: Colors.transparent,
        body: _buildBody(context),
      ),
    );
  }

  /// 渲染主体: 根据 _renderMode 分流
  /// - '3d'   : 3D 设备占位卡片场景
  /// - 'material' / 'fluent' / 'chart' : 走 PlatformRenderer
  /// - 默认    : 占位文字
  Widget _buildBody(BuildContext context) {
    if (_renderMode == '3d') {
      return _buildDevice3DScene(context);
    }
    if (_uiNode != null) {
      return PlatformRenderer(_renderMode).build(_uiNode!, context);
    }
    return const Center(
      child: Text(
        'canvas_preview',
        style: TextStyle(
          color: Color(0x44FFFFFF),
          fontSize: 16,
          fontWeight: FontWeight.w300,
        ),
      ),
    );
  }

  /// 3D 设备场景: 用 InAppWebView + model-viewer 加载真实 GLB 模型
  ///
  /// 工作流:
  ///   1. selectDevice 时记录 _currentGlbPath (相对 modelsDir/3d/)
  ///   2. _buildDevice3DScene 据此构造 HTML, 用 model-viewer 标签加载 GLB
  ///   3. GLB 文件由内置 HTTP 服务 /models/3d/xxx.glb 提供
  ///   4. 文件变化时 _reloadModel 通过 JS 切换 model-viewer.src 实现热加载
  ///
  /// 用户原话: "只要能把模型加载出来就行了，不需要做任何修改"
  /// 所以这里只做查看器, 不做编辑/纹理贴图等复杂功能。
  Widget _buildDevice3DScene(BuildContext context) {
    if (_devices.isEmpty) {
      return Container(
        color: const Color(0xFF3A3A3C),
        child: const Center(
          child: Text(
            '3D 设备场景\n从右侧选择设备预设',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Color(0xAAFFFFFF),
              fontSize: 12,
              fontWeight: FontWeight.w300,
              height: 1.6,
            ),
          ),
        ),
      );
    }

    // ★ 有 GLB 路径: 用 InAppWebView + model-viewer 加载真实 3D 模型
    final glbPath = _currentGlbPath;
    if (glbPath != null && glbPath.isNotEmpty) {
      return _buildModelViewer(glbPath);
    }

    // 兜底: 没指定 GLB 文件时显示 2D 占位卡片 (保留向后兼容)
    return _buildPlaceholderScene();
  }

  /// 设备屏幕区域配置: modelKey -> {x, y, w, h, radius}
  /// 比例值 (0~1), 相对于 WebView 尺寸
  /// x,y = 屏幕左上角位置; w,h = 屏幕宽高; radius = 屏幕圆角(px)
  static const Map<String, Map<String, double>> _screenRegions = {
    'm-iphone14pro':    {'x': 0.30, 'y': 0.10, 'w': 0.40, 'h': 0.78, 'r': 18},
    'm-iphone15promax': {'x': 0.30, 'y': 0.10, 'w': 0.40, 'h': 0.78, 'r': 18},
    'm-iphone11promax': {'x': 0.30, 'y': 0.10, 'w': 0.40, 'h': 0.78, 'r': 18},
  };
  static const Map<String, double> _defaultScreenRegion = {'x': 0.30, 'y': 0.10, 'w': 0.40, 'h': 0.78, 'r': 18};

  /// 用 InAppWebView 加载包含 model-viewer 的 HTML 页面 + 叠加 2D UI
  Widget _buildModelViewer(String glbPath) {
    final port = widget.port;
    final modelUrl = 'http://127.0.0.1:$port/models/3d/$glbPath';

    // ★ model-viewer.min.js 通过同源 HTTP 加载 (避免 data URL 下的 module CORS 问题)
    final scriptTag = '<script type="module" src="/assets/model-viewer.min.js"></script>';

    // 构造 HTML: 引入 model-viewer web component, 加载 GLB
    // - 关掉 auto-rotate: 固定正面视角, 保证屏幕区域位置稳定
    // - 固定 camera-orbit: 正面视角 (0deg azimuth, 90deg elevation)
    // - 灰色背景: 避免纯白误报
    // - 默认材质灰色: 模型加载后 JS 把所有材质设为灰色 (#888)
    // - 暴露 setModelColor 函数: Flutter 右键菜单调用
    // - camera-controls 动态控制: 设计模式禁用, 查看模式启用
    final html = '''<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%; height: 100%;
      background: #3a3a3c;
      overflow: hidden;
    }
    model-viewer {
      width: 100vw;
      height: 100vh;
      background: #3a3a3c;
      --poster-color: #3a3a3c;
    }
    #loading {
      position: fixed; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      color: rgba(255,255,255,0.7);
      font-family: monospace; font-size: 12px;
      z-index: 1;
    }
    /* ★ 右键菜单样式 */
    #ctx-menu {
      position: fixed; display: none;
      background: #2A2A2C; border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      padding: 4px 0; min-width: 160px;
      z-index: 100; font-family: -apple-system, sans-serif;
    }
    #ctx-menu.show { display: block; }
    #ctx-menu .item {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px; cursor: pointer;
      color: rgba(255,255,255,0.7); font-size: 12px;
      transition: background 0.1s;
    }
    #ctx-menu .item:hover { background: rgba(255,255,255,0.08); color: #fff; }
    #ctx-menu .sep { height: 1px; background: rgba(255,255,255,0.1); margin: 4px 0; }
    #ctx-menu .swatch { width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.2); }
  </style>
  $scriptTag
</head>
<body>
  <div id="loading">Loading 3D model...</div>
  <model-viewer
    src="$modelUrl"
    alt="3D device model"
    camera-orbit="0deg 90deg 100%"
    shadow-intensity="1"
    environment-image="neutral"
    exposure="1"
    style="background-color: #3a3a3c;">
  </model-viewer>

  <!-- ★ 右键菜单 DOM -->
  <div id="ctx-menu">
    <div class="item" data-action="mode">📡 <span id="mode-label">切换到查看模式</span></div>
    <div class="sep"></div>
    <div class="item" data-color="#888888"><span class="swatch" style="background:#888888"></span>默认灰</div>
    <div class="item" data-color="#FFFFFF"><span class="swatch" style="background:#FFFFFF"></span>白色</div>
    <div class="item" data-color="#222222"><span class="swatch" style="background:#222222"></span>黑色</div>
    <div class="item" data-color="#C0C0C0"><span class="swatch" style="background:#C0C0C0"></span>银色</div>
    <div class="item" data-color="#4A4A4A"><span class="swatch" style="background:#4A4A4A"></span>深空灰</div>
    <div class="item" data-color="#D4AF37"><span class="swatch" style="background:#D4AF37"></span>金色</div>
    <div class="item" data-color="#E8B4B8"><span class="swatch" style="background:#E8B4B8"></span>玫瑰金</div>
    <div class="item" data-color="#1A2B4A"><span class="swatch" style="background:#1A2B4A"></span>深蓝色</div>
    <div class="item" data-color="#2D5F3F"><span class="swatch" style="background:#2D5F3F"></span>绿色</div>
    <div class="item" data-color="#8B2D2D"><span class="swatch" style="background:#8B2D2D"></span>红色</div>
  </div>
  <script>
    const mv = document.querySelector('model-viewer');
    const loading = document.getElementById('loading');

    // ★ 默认材质颜色: 灰色 (#888888)
    //   model-viewer 加载完 GLB 后, 遍历所有 material 把 baseColorFactor 设为灰色
    //   暴露 window.setModelColor(hex) 供 Flutter 调用
    function applyColorToMaterials(r, g, b) {
      if (!mv || !mv.model) return false;
      try {
        const materials = mv.model.materials;
        for (const mat of materials) {
          if (mat.pbrMetallicRoughness) {
            mat.pbrMetallicRoughness.setBaseColorFactor([r, g, b, 1.0]);
          }
        }
        return true;
      } catch (e) {
        console.log('[color-error] ' + e.message);
        return false;
      }
    }

    function hexToRgb(hex) {
      const h = hex.replace('#', '');
      return [
        parseInt(h.substring(0,2), 16) / 255,
        parseInt(h.substring(2,4), 16) / 255,
        parseInt(h.substring(4,6), 16) / 255
      ];
    }

    // Flutter 调用: window.soloforgeAPI.setModelColor('#FF0000')
    window.soloforgeAPI = {
      setModelColor: function(hex) {
        const rgb = hexToRgb(hex);
        return applyColorToMaterials(rgb[0], rgb[1], rgb[2]);
      },
      setCameraControls: function(enabled) {
        if (mv) {
          if (enabled) {
            mv.setAttribute('camera-controls', '');
          } else {
            mv.removeAttribute('camera-controls');
          }
        }
      },
      resetCamera: function() {
        if (mv) {
          mv.cameraOrbit = '0deg 90deg 100%';
        }
      }
    };

    // 模型加载后默认设为灰色
    if (mv) {
      mv.addEventListener('error', (e) => {
        console.log('[mv-error] ' + (e.detail?.message || 'unknown'));
        if (loading) loading.textContent = 'Model load failed: ' + (e.detail?.message || 'unknown');
      });
      mv.addEventListener('load', () => {
        console.log('[mv-load] ok src=' + mv.src);
        if (loading) loading.style.display = 'none';
        // ★ 默认灰色材质
        setTimeout(() => {
          const ok = applyColorToMaterials(0.533, 0.533, 0.533); // #888888
          console.log('[mv-color] default gray applied: ' + ok);
        }, 200);
      });
      mv.addEventListener('preload', () => {
        console.log('[mv-preload] ' + mv.src);
      });
    }
    window.addEventListener('error', (e) => {
      console.log('[window-error] ' + (e.message || ''));
    });

    // ★ 右键菜单: WebView 内部处理, 通过 console.log 传回 Flutter
    //   避免 Flutter GestureDetector 被 InAppWebView 拦截的问题
    const ctxMenu = document.getElementById('ctx-menu');
    const modeLabel = document.getElementById('mode-label');

    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ctxMenu.style.left = e.clientX + 'px';
      ctxMenu.style.top = e.clientY + 'px';
      ctxMenu.classList.add('show');
    });

    document.addEventListener('click', (e) => {
      if (!ctxMenu.contains(e.target)) {
        ctxMenu.classList.remove('show');
        return;
      }
      const item = e.target.closest('.item');
      if (!item) return;

      const action = item.dataset.action;
      const color = item.dataset.color;

      if (action === 'mode') {
        // 通过 console.log 通知 Flutter 切换模式
        console.log('[ctx-action] mode_toggle');
      } else if (color) {
        // 直接在 JS 层改颜色
        const ok = window.soloforgeAPI.setModelColor(color);
        console.log('[ctx-action] color ' + color + ' ok=' + ok);
      }
      ctxMenu.classList.remove('show');
    });

    // ★ 模式切换时更新菜单文字 (由 Flutter 调用)
    window.soloforgeAPI.updateModeLabel = function(isViewMode) {
      if (modeLabel) modeLabel.textContent = isViewMode ? '切换到设计模式' : '切换到查看模式';
    };
  </script>
</body>
</html>''';

    // ★ 获取当前设备的屏幕区域配置
    final dev = _devices.values.isNotEmpty ? _devices.values.first : null;
    final region = _screenRegions[dev?.modelKey] ?? _defaultScreenRegion;

    return LayoutBuilder(
      builder: (context, constraints) {
        final w = constraints.maxWidth;
        final h = constraints.maxHeight;

        return Stack(
          children: [
            // 底层: 3D 模型 (InAppWebView) — 填满整个 Stack
            Positioned.fill(
              child: InAppWebView(
                initialData: InAppWebViewInitialData(
                  data: html,
                  mimeType: 'text/html',
                  encoding: 'utf-8',
                  baseUrl: WebUri('http://127.0.0.1:$port/'),
                ),
                initialSettings: InAppWebViewSettings(
                  transparentBackground: false,
                  allowsInlineMediaPlayback: true,
                  mediaPlaybackRequiresUserGesture: false,
                  allowFileAccessFromFileURLs: true,
                  allowUniversalAccessFromFileURLs: true,
                  javaScriptEnabled: true,
                  domStorageEnabled: true,
                ),
                onWebViewCreated: (controller) {
                  _webviewController = controller;
                  _writeLog('[webview] created, modelUrl=$modelUrl jsCached=${_modelViewerJs?.isNotEmpty ?? false}');
                },
                onLoadStart: (controller, url) {
                  _writeLog('[webview] load start: $url');
                },
                onLoadStop: (controller, url) {
                  _writeLog('[webview] load stop: $url');
                  // ★ 页面加载完, 根据当前模式设置 camera-controls
                  _applyViewMode();
                },
                onLoadError: (controller, url, code, message) {
                  _writeLog('[webview] load error: code=$code msg=$message url=$url');
                },
                onConsoleMessage: (controller, consoleMessage) {
                  final msg = consoleMessage.message;
                  _writeLog('[webview-console] $msg');
                  // ★ FIX: 精确匹配, 避免外部 UI 数据含子串误触发模式切换
                  if (msg.trim() == '[ctx-action] mode_toggle') {
                    _toggleViewMode();
                  }
                },
              ),
            ),

            // ★ 上层: 2D UI 内容叠加在 3D 模型屏幕区域
            //   仅在设计模式 (_viewMode=false) 显示; 查看模式隐藏让用户自由旋转
            //   Positioned 定位到屏幕区域, ClipRRect 裁剪圆角,
            //   FittedBox 自适应缩放 2D UI 到屏幕区域
            //   ★ 不加 GestureDetector: 右键菜单改由 WebView 内部 JS 实现,
            //     避免 Flutter 层拦截事件导致 2D UI 按钮无法点击
            if (_uiNode != null && !_viewMode)
              Positioned(
                left: w * (region['x'] ?? 0.30),
                top: h * (region['y'] ?? 0.10),
                width: w * (region['w'] ?? 0.40),
                height: h * (region['h'] ?? 0.78),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(region['r'] ?? 18),
                  child: Container(
                    color: Colors.white,
                    child: FittedBox(
                      fit: BoxFit.contain,
                      alignment: Alignment.topCenter,
                      child: SizedBox(
                        width: (dev != null && _nativeSizes[dev.id] != null)
                            ? _nativeSizes[dev.id]!.$1
                            : 393.0,
                        height: (dev != null && _nativeSizes[dev.id] != null)
                            ? _nativeSizes[dev.id]!.$2
                            : 852.0,
                        child: PlatformRenderer('material').build(_uiNode!, context),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  /// ★ 切换查看/设计模式 (由右键菜单 console.log 触发)
  void _toggleViewMode() {
    setState(() {
      _viewMode = !_viewMode;
    });
    _applyViewMode();
    _writeLog('[view-mode] toggled: ${_viewMode ? "查看" : "设计"}');
  }

  /// 应用当前模式到 WebView (camera-controls 开关 + 菜单文字更新)
  void _applyViewMode() {
    final ctrl = _webviewController;
    if (ctrl == null) return;
    // 查看模式: 启用 camera-controls 允许旋转; 设计模式: 禁用固定正面
    ctrl.evaluateJavascript(source: 'window.soloforgeAPI && window.soloforgeAPI.setCameraControls(${_viewMode ? 'true' : 'false'});').catchError((e) {
      _writeLog('[view-mode] apply error: $e');
    });
    // 切回设计模式时重置相机到正面
    if (!_viewMode) {
      ctrl.evaluateJavascript(source: 'window.soloforgeAPI && window.soloforgeAPI.resetCamera();').catchError(() {});
    }
    // 更新右键菜单文字
    ctrl.evaluateJavascript(source: 'window.soloforgeAPI && window.soloforgeAPI.updateModeLabel(${_viewMode ? 'true' : 'false'});').catchError(() {});
  }

  /// 兜底 2D 占位卡片场景 (无 GLB 文件时)
  Widget _buildPlaceholderScene() {
    return LayoutBuilder(
      builder: (context, constraints) {
        return Stack(
          children: _devices.values.map((dev) {
            final group = _groupOf(dev.modelKey);
            final ns = _nativeSizes[dev.id] ?? (0.0, 0.0);
            final nw = ns.$1;
            final nh = ns.$2;
            // 归一化到 base = 220, 保持 nativeSize 比例
            double baseW, baseH;
            if (nw > 0 && nh > 0) {
              if (nw >= nh) {
                baseW = 220;
                baseH = 220 * (nh / nw);
              } else {
                baseH = 220;
                baseW = 220 * (nw / nh);
              }
            } else {
              baseW = 220;
              baseH = 140;
            }
            // watch 用正方形
            if (group == 'watch') {
              baseW = 150;
              baseH = 150;
            }
            final x = dev.xRatio * constraints.maxWidth;
            final y = dev.yRatio * constraints.maxHeight;
            return Positioned(
              left: x - baseW / 2,
              top: y - baseH / 2,
              child: Transform(
                alignment: Alignment.center,
                transform: Matrix4.identity()
                  ..setEntry(3, 2, 0.001) // 透视
                  ..rotateX(dev.rotationX)
                  ..rotateY(dev.rotationY)
                  ..rotateZ(dev.rotationZ)
                  ..scale(dev.displayScale),
                child: _DevicePlaceholderCard(
                  dev: dev,
                  baseWidth: baseW,
                  baseHeight: baseH,
                  group: group,
                ),
              ),
            );
          }).toList(),
        );
      },
    );
  }
}

/// 设备占位卡片
///
/// 区分横屏/竖屏/圆形 + 选中高亮 + modelKey 文字
/// mobile: 竖屏圆角矩形 深绿; tablet: 圆角矩形 深紫;
/// watch: 圆形 深红; desktop: 横屏矩形 深蓝
class _DevicePlaceholderCard extends StatelessWidget {
  final DeviceInstance dev;
  final double baseWidth;
  final double baseHeight;
  final String group;

  const _DevicePlaceholderCard({
    required this.dev,
    required this.baseWidth,
    required this.baseHeight,
    required this.group,
  });

  (double, Color, bool) get _style {
    switch (group) {
      case 'mobile':
        return (18.0, const Color(0x88204a3a), false);
      case 'tablet':
        return (16.0, const Color(0x88302a4a), false);
      case 'watch':
        return (0.0, const Color(0x884a2a2a), true);
      default:
        return (8.0, const Color(0x882a2a3a), false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final style = _style;
    final radius = style.$1;
    final fillColor = style.$2;
    final isCircle = style.$3;
    final borderColor = dev.isSelected
        ? const Color(0xFFFF6B6B)
        : const Color(0x44FFFFFF);

    return Container(
      width: baseWidth,
      height: baseHeight,
      decoration: BoxDecoration(
        color: fillColor,
        borderRadius: isCircle ? null : BorderRadius.circular(radius),
        shape: isCircle ? BoxShape.circle : BoxShape.rectangle,
        border: Border.all(
          color: borderColor,
          width: dev.isSelected ? 2 : 1,
        ),
        boxShadow: [
          if (dev.isSelected)
            const BoxShadow(
              color: Color(0x88FF6B6B),
              blurRadius: 16,
              spreadRadius: 1,
            ),
        ],
      ),
      alignment: Alignment.center,
      child: Padding(
        padding: EdgeInsets.all(isCircle ? 8 : 12),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              group.toUpperCase(),
              style: TextStyle(
                color: const Color(0xFFEEEEEE).withOpacity(0.55),
                fontSize: isCircle ? 8 : 9,
                fontWeight: FontWeight.w300,
                letterSpacing: 1.0,
              ),
            ),
            SizedBox(height: isCircle ? 2 : 4),
            Text(
              dev.modelKey,
              style: TextStyle(
                color: const Color(0xFFEEEEEE),
                fontSize: isCircle ? 9 : 10,
                fontWeight: FontWeight.w500,
              ),
              textAlign: TextAlign.center,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }
}
