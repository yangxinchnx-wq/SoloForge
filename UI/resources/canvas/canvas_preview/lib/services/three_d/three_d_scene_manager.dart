// three_d Scene 管理器 (s2.1 架构接入)
//
// 职责:
//   1. 管理共享的 Scene / Camera / Lights
//   2. 为每个 device 维护一个 DeviceRenderer 实例
//   3. 提供 place / remove / update 设备 API
//   4. 失败时降级 (s2.1 阶段: GLB 缺失 → 用 BoxGeometry placeholder)
//   5. 提供 TextureRegistry 绑定钩子, s3.1 FFI 修复后能直接接入 WebGL
//
// s2.1 阶段实际能做什么:
//   - 类的边界 + API 完整
//   - 内部用 three_d 的内存数据模型 (Scene/Camera/Mesh) 算好 transform
//   - 真实 WebGL 渲染依赖 s3.1 (FFI TextureRegistry 接入)
//   - 当前阶段, 真实像素输出仍走 s1.7 的 2D Container
//
// s3.1 完成后切换流程:
//   1. ThreeDSceneManager.attachToTexture(textureId) 绑定到 FlutterTextureRegistry
//   2. setRenderCallback(onFrameReady) 每帧推 RenderTexture 给 Flutter
//   3. main.dart 用 Texture widget 替代 s1.7 的 _DevicePlaceholderCard

import 'dart:async';
import 'package:flutter/foundation.dart';
import 'device_renderer.dart';
import '../../ui_parser.dart';

/// s2.1: 设备 transform 增量更新
///
/// React 端通过 IPC 推过来, 经 main.dart 解析后调 manager.updateDevice
class DeviceTransformUpdate {
  final String deviceId;
  final double xRatio;
  final double yRatio;
  final double rotationX;
  final double rotationY;
  final double rotationZ;
  final double displayScale;
  final bool isSelected;
  final String highlightColor;

  const DeviceTransformUpdate({
    required this.deviceId,
    required this.xRatio,
    required this.yRatio,
    required this.rotationX,
    required this.rotationY,
    required this.rotationZ,
    required this.displayScale,
    required this.isSelected,
    required this.highlightColor,
  });
}

/// s2.1: 共享的 three_d 场景管理
///
/// 生命周期: 在 main.dart initState 时创建, dispose 时销毁
class ThreeDSceneManager {
  /// 共享 scene 引用, 暴露给 s3.1 的 WebGL 渲染循环
  ///
  /// 真实 GL 上下文绑定在 s3.1 完成, 这里只持有数据模型
  Object? _scene;

  /// 设备渲染器映射: deviceId -> DeviceRenderer
  final Map<String, DeviceRenderer> _devices = {};

  /// 当前活跃 session
  String? _activeSessionId;

  /// 画布尺寸 (用于 camera aspect ratio)
  double _canvasWidth = 800;
  double _canvasHeight = 600;

  /// 初始化是否成功
  bool _initialized = false;
  String? _initError;

  /// s2.1 调试: 每次 scene update 计数
  int _updateCount = 0;

  /// 当前是否处于可用状态 (无 fatal error)
  bool get isAvailable => _initialized && _initError == null;

  /// 初始化错误 (如果有, UI 可以展示)
  String? get initError => _initError;

  /// 设备数量
  int get deviceCount => _devices.length;

  /// 已注册的设备 ID
  List<String> get deviceIds => _devices.keys.toList();

  /// 初始化
  ///
  /// s2.1 阶段: 仅做占位初始化, 不创建真实 GL 上下文
  ///   真实 GL 初始化 (WebGLRenderer + TextureRegistry) 在 s3.1 接入
  Future<void> init({
    required double canvasWidth,
    required double canvasHeight,
  }) async {
    _canvasWidth = canvasWidth;
    _canvasHeight = canvasHeight;
    try {
      // s2.1: 暂不创建 WebGLRenderer (s3.1 接入)
      // 仅记录尺寸 + 标记就绪
      _scene = _ScenePlaceholder();
      _initialized = true;
      _initError = null;
    } catch (e) {
      _initialized = false;
      _initError = e.toString();
    }
  }

  /// s2.1: 注册/更新一个设备
  ///
  /// - 新设备: 创建 DeviceRenderer 并 init
  /// - 已有: 调 setPosition / setRotation / setSelected
  Future<void> updateDevice(
    String sessionId,
    String deviceId,
    DeviceModelConfig config,
    DeviceTransformUpdate update,
  ) async {
    if (!isAvailable) return;
    _activeSessionId = sessionId;

    var renderer = _devices[deviceId];
    if (renderer == null) {
      try {
        renderer = DeviceRenderer(
          sessionId: sessionId,
          config: config,
        );
        await renderer.init(
          canvasWidth: _canvasWidth.toInt(),
          canvasHeight: _canvasHeight.toInt(),
        );
        _devices[deviceId] = renderer;
      } catch (e) {
        // s2.1: 单个设备初始化失败不阻断其他
        _initError = 'device init failed: $e';
        return;
      }
    }

    renderer!
      ..setPosition(update.xRatio, update.yRatio)
      ..setRotation(update.rotationX, update.rotationY, update.rotationZ)
      ..setDisplayScale(update.displayScale)
      ..setSelected(update.isSelected, colorHex: update.highlightColor);

    _updateCount++;
  }

  /// s2.1: 移除一个设备
  void removeDevice(String deviceId) {
    final renderer = _devices.remove(deviceId);
    renderer?.dispose();
  }

  /// s2.1: 切 session 时清空
  void clearSession() {
    for (final r in _devices.values) {
      r.dispose();
    }
    _devices.clear();
    _activeSessionId = null;
  }

  /// s2.1: 同步画布尺寸 (preview panel 拖拽边栏时)
  void setCanvasSize(double width, double height) {
    _canvasWidth = width;
    _canvasHeight = height;
    // 真实 camera aspect 在 s3.1 接入时更新
  }

  /// s2.1: 调试用统计
  Map<String, dynamic> getDebugInfo() {
    return {
      'initialized': _initialized,
      'initError': _initError,
      'deviceCount': _devices.length,
      'updateCount': _updateCount,
      'activeSessionId': _activeSessionId,
      'canvasSize': '$_canvasWidth x $_canvasHeight',
    };
  }

  /// s2.1: 暴露给 s3.1 的 scene 引用 (未类型化, 避免编译期依赖 three_d)
  Object? get sceneRef => _scene;

  void dispose() {
    clearSession();
    _scene = null;
    _initialized = false;
  }
}

/// s2.1: scene 数据模型占位
///
/// s3.1 会替换为真实的 td.Scene
class _ScenePlaceholder {
  const _ScenePlaceholder();
}
