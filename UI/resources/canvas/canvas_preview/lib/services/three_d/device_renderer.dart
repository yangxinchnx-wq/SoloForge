// 3D 设备模型渲染器 (STUB 版, s2.1 占位)
//
// s2.1 设计: 用 three_d 包做真实 GLB 加载 + WebGL 渲染
// 当前阶段: three_d / three_d_artifacts / vector_math 在 pub.dev 不可达,
//   Zoadian/three.d 仓库不可直接解析为 pub package.
//
// 保留 DeviceRenderer 接口 (init / setPosition / setRotation / setSelected /
// setDisplayScale / render / dispose / updateScreenTexture), 内部实现:
//   - 不创建 three_d Scene/Camera/Mesh
//   - 保留状态 (_rotationX/Y/Z, _xRatio, _yRatio, _displayScale, _isSelected)
//   - render() 是 no-op, 实际像素输出仍走 main.dart s1.7 的 2D Container
//   - 切换到真实 three_d 时, 把 stub 方法替换为 three_d 实现即可,
//     调用方 three_d_scene_manager.dart 完全不动
//
// s3.1+ 接入真实 three_d 的步骤:
//   1. pubspec.yaml 加回 three_d / three_d_artifacts / vector_math (用 git path 引用)
//   2. 恢复这个文件原本的 three_d 实现 (git 历史里有完整版本)
//   3. ThreeDSceneManager.attachToTexture() 接到 FlutterTextureRegistry
//   4. main.dart 的 _DevicePlaceholderCard 换 Texture widget
//
// 当前 stub 影响范围: 仅 canvas 内的 3D 视觉渲染, 不影响 IPC / WS / HTTP /
// pushUI / transform 等所有通讯与数据流.

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart' as material;
import '../../ui_parser.dart';

class DeviceRenderer {
  final String sessionId;
  final DeviceModelConfig config;
  final Function(Uint8List?)? onScreenTextureUpdate;
  final Function(String error)? onError;

  bool _isModelLoaded = false;
  bool _isPlaceholder = true;
  String? _lastError;

  // 状态 (保留, 切换到真实 three_d 时映射到 mesh.rotation / mesh.position)
  double _rotationX = 0;
  double _rotationY = 0;
  double _rotationZ = 0;
  double _xRatio = 0.5;
  double _yRatio = 0.5;
  double _displayScale = 1.0;
  bool _isSelected = false;
  String _highlightColorHex = '#FF6B6B';

  DeviceRenderer({
    required this.sessionId,
    required this.config,
    this.onScreenTextureUpdate,
    this.onError,
  });

  // ───────────────────────────────────────────
  // 初始化 (stub: 仅记录尺寸, 不创建 three_d 场景)
  // ───────────────────────────────────────────
  Future<void> init({
    required int canvasWidth,
    required int canvasHeight,
  }) async {
    try {
      // s2.1 stub: 不创建 Scene/Camera/Light
      // 等待 s3.1+ 接入真实 three_d 时恢复
      _isPlaceholder = true;
      _lastError = 'three_d renderer in stub mode (s2.1 placeholder)';

      // 检查 GLB 模型是否存在 (即使不渲染也走完路径, 用于日志验证)
      final modelPath = await _resolveModelPath();
      if (modelPath != null) {
        _isModelLoaded = true;
        _isPlaceholder = false;
      } else {
        _lastError = 'Model file not found: ${config.file} (stub mode, no actual render)';
        onError?.call(_lastError!);
      }
    } catch (e) {
      _lastError = e.toString();
      onError?.call(_lastError!);
    }
  }

  Future<String?> _resolveModelPath() async {
    final candidates = <String>[];
    final envDir = Platform.environment['SOLOFORGE_MODELS_DIR'];
    if (envDir != null && envDir.isNotEmpty) {
      candidates.add('$envDir/${config.file}');
    }
    final exeDir = _getCanvasExeDir();
    candidates.add('$exeDir/models/${config.file}');
    candidates.add('${_parent(exeDir)}/models/${config.file}');
    candidates.add('${_parent(_parent(exeDir))}/models/${config.file}');
    for (final p in candidates) {
      if (await File(p).exists()) return p;
    }
    return null;
  }

  static String _parent(String path) {
    final parts = path.split(RegExp(r'[/\\]'));
    if (parts.isEmpty) return path;
    parts.removeLast();
    return parts.join('/');
  }

  String _getCanvasExeDir() {
    final exe = Platform.resolvedExecutable;
    return File(exe).parent.path;
  }

  // ───────────────────────────────────────────
  // 状态更新 (stub: 仅记录, 不下发到 mesh)
  // ───────────────────────────────────────────
  void setPosition(double xRatio, double yRatio) {
    _xRatio = xRatio;
    _yRatio = yRatio;
  }

  void setRotation(double rx, double ry, double rz) {
    _rotationX = rx;
    _rotationY = ry;
    _rotationZ = rz;
  }

  void setSelected(bool selected, {String? colorHex}) {
    _isSelected = selected;
    if (colorHex != null) _highlightColorHex = colorHex;
  }

  void setDisplayScale(double scale) {
    _displayScale = scale;
  }

  void updateScreenTexture(Uint8List rgbaBytes, int width, int height) {
    onScreenTextureUpdate?.call(rgbaBytes);
  }

  // ───────────────────────────────────────────
  // 渲染 (stub: no-op, 像素输出仍由 main.dart s1.7 Container 处理)
  // ───────────────────────────────────────────
  void render() {
    // no-op
  }

  // ───────────────────────────────────────────
  // 资源清理 (stub: 无 three_d 资源需释放)
  // ───────────────────────────────────────────
  void dispose() {
    // no-op
  }

  // ───────────────────────────────────────────
  // 调试 getter (测试 / 日志用)
  // ───────────────────────────────────────────
  bool get isModelLoaded => _isModelLoaded;
  bool get isPlaceholder => _isPlaceholder;
  String? get lastError => _lastError;
  double get rotationX => _rotationX;
  double get rotationY => _rotationY;
  double get rotationZ => _rotationZ;
  double get xRatio => _xRatio;
  double get yRatio => _yRatio;
  double get displayScale => _displayScale;
  bool get isSelected => _isSelected;
  String get highlightColorHex => _highlightColorHex;
}
