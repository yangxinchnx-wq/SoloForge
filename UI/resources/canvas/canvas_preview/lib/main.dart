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

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  final args = List<String>.from(Platform.environment['FLUTTER_ARGS']?.split(' ') ?? [])
    ..addAll(Platform.environment.keys.where((k) => k.startsWith('--')).map((k) => '${k}=${Platform.environment[k]}'));

  int port = 9090;
  int? parentHwnd;

  for (final arg in args) {
    if (arg.startsWith('--port=')) {
      port = int.tryParse(arg.substring(7)) ?? 9090;
    } else if (arg.startsWith('--parent-hwnd=')) {
      parentHwnd = int.tryParse(arg.substring(13));
    }
  }

  for (int i = 0; i < args.length; i++) {
    if (args[i] == '--port' && i + 1 < args.length) {
      port = int.tryParse(args[i + 1]) ?? 9090;
    } else if (args[i] == '--parent-hwnd' && i + 1 < args.length) {
      parentHwnd = int.tryParse(args[i + 1]);
    }
  }

  runApp(CanvasApp(port: port, parentHwnd: parentHwnd));
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
    try {
      final hwnd = _getActiveWindow();
      if (hwnd == 0) return;

      if (widget.parentHwnd != null && widget.parentHwnd != 0) {
        _setParent(hwnd, widget.parentHwnd!);

        final currentStyle = _getWindowLongPtrW(hwnd, _gwlStyle);
        final newStyle = (currentStyle &
                ~(_wsCaption |
                    _wsThickFrame |
                    _wsMinimizeBox |
                    _wsMaximizeBox |
                    _wsSysMenu |
                    _wsPopup)) |
            _wsChild |
            _wsVisible;
        _setWindowLongPtrW(hwnd, _gwlStyle, newStyle);
      } else {
        final currentStyle = _getWindowLongPtrW(hwnd, _gwlStyle);
        final newStyle = (currentStyle &
                ~(_wsCaption |
                    _wsThickFrame |
                    _wsMinimizeBox |
                    _wsMaximizeBox |
                    _wsSysMenu)) |
            _wsPopup |
            _wsVisible;
        _setWindowLongPtrW(hwnd, _gwlStyle, newStyle);
      }

      _setWindowPos(
          hwnd,
          0,
          0,
          0,
          0,
          0,
          _swpFrameChanged | _swpNoMove | _swpNoSize | _swpNoZOrder | _swpShowWindow);
    } catch (_) {}
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

      if (data.containsKey('mode')) {
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
