import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:flutter/material.dart';
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
            _currentGlbPath = null;
          });
          _stopModelWatcher();
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
          _uiNode = null;
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
        setState(() {
          _renderMode = 'material';
          _devices.clear();
          _nativeSizes.clear();
        });
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
    ctrl.evaluateJavascript(source: '''
      const mv = document.querySelector('model-viewer');
      if (mv) {
        mv.src = "$url?t=${DateTime.now().millisecondsSinceEpoch}";
      }
    ''');
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

  /// 3D 设备场景 (2D 占位卡片可视化)
  ///
  /// 真实 GLB 模型渲染需要 three_d + FFI + WebGL 上下文 (未完成模块),
  /// 当前用 2D Stack + Transform 矩阵让选中的设备以卡片形式可视化显示在画布上。
  /// 按 group (mobile/tablet/desktop/watch) 区分形状 + 颜色, nativeSize 决定比例。
  Widget _buildDevice3DScene(BuildContext context) {
    if (_devices.isEmpty) {
      return const Center(
        child: Text(
          '3D 设备场景\n从右侧选择设备预设',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: Color(0x66FFFFFF),
            fontSize: 12,
            fontWeight: FontWeight.w300,
            height: 1.6,
          ),
        ),
      );
    }

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
