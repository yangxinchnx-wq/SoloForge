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
      parentHwnd = int.tryParse(a.substring(13));
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
      await for (final request in _httpServer!) {
        if (request.uri.path == '/ws' || request.uri.path == '/') {
          try {
            final channel = await WebSocketTransformer.upgrade(request);
            channel.listen((dynamic data) {
              if (data is String) {
                _handleMessage(data);
              }
            }, onError: (_) {}, cancelOnError: false);
          } catch (_) {}
        } else if (request.method == 'POST' && request.uri.path == '/render') {
          await _handleHttpRender(request);
        } else {
          request.response.statusCode = 404;
          await request.response.close();
        }
      }
    } catch (_) {}
  }

  Future<void> _handleHttpRender(HttpRequest request) async {
    try {
      final body = await utf8.decoder.bind(request).join();
      _handleMessage(body);
      request.response.statusCode = 200;
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode({ 'ok': true }));
    } catch (e) {
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
        setState(() {
          if (mode != null) _renderMode = mode;
          if (uiData != null) _uiNode = UiParser.parse(uiData);
        });
      }
    } catch (_) {}
  }

  @override
  void dispose() {
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
