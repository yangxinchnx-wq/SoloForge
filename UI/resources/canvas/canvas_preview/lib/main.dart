import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:flutter/material.dart';
import 'ui_parser.dart';
import 'platform_renderer.dart';

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
    }
  }

  _writeLog('[main] started port=$port parentHwnd=$parentHwnd args=${args.join(" ")}');

  runApp(CanvasApp(port: port, parentHwnd: parentHwnd));
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

  const CanvasApp({super.key, required this.port, this.parentHwnd});

  @override
  State<CanvasApp> createState() => _CanvasAppState();
}

class _CanvasAppState extends State<CanvasApp> {
  HttpServer? _httpServer;
  UiNode? _uiNode;
  String _renderMode = 'material';

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

  /// 并发处理每个 HTTP 请求 — 不阻塞事件循环
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

  @override
  void dispose() {
    _setStateTimer?.cancel();
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
        body: _uiNode != null
            ? PlatformRenderer(_renderMode).build(_uiNode!, context)
            : const Center(
                child: Text(
                  'canvas_preview',
                  style: TextStyle(
                    color: Color(0x44FFFFFF),
                    fontSize: 16,
                    fontWeight: FontWeight.w300,
                  ),
                ),
              ),
      ),
    );
  }
}
