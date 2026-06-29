// 设备配置加载器
// 从 device-config.json 加载 22 个设备的配置
//
// s1.6: 增加边界处理
//   - JSON 解析失败 / 文件缺失: 走 _loadDefaults(), 记录错误
//   - 单个设备校验失败: 该设备跳过, 错误累计到 ConfigValidationResult.errors
//   - 提供 loadAllDetailed() 返回 (configs, errors) 替代静默 fallback
//   - 提供 getLastValidation() 用于 IPC 端点查询错误列表

import 'dart:convert';
import 'dart:io';
import '../../ui_parser.dart';

class DeviceConfigLoader {
  // 旧 API 缓存 (loadAll() 用)
  static Map<String, DeviceModelConfig>? _cache;

  // s1.6: 上一次详细校验结果 (含 errors)
  static ConfigValidationResult? _lastResult;

  /// 显式指定的 models 目录(主进程通过 --models-dir 注入)
  static String? _overrideDir;

  /// 设置 models 目录(由 main.dart 在启动时调用)
  static void setModelsDir(String? dir) {
    if (dir != null && dir.isNotEmpty) {
      _overrideDir = dir;
    }
  }

  /// 清空缓存 (用于 hot-reload 调试)
  static void clearCache() {
    _cache = null;
    _lastResult = null;
  }

  /// 旧 API: 仅返回 configs, 兼容老调用方
  ///
  /// 内部委托 loadAllDetailed() 跑一次, 然后只取 configs 部分
  /// 错误信息通过 getLastValidation() 获取
  static Future<Map<String, DeviceModelConfig>> loadAll() async {
    if (_cache != null) return _cache!;
    final result = await loadAllDetailed();
    return result.configs;
  }

  /// s1.6: 详细校验 — 返回 configs + errors
  ///
  /// 错误流:
  ///   1. 文件不存在 / 读取失败: 一个 _FILE_LEVEL error (modelKey='<file>')
  ///   2. JSON 解析失败: 一个 _PARSE_LEVEL error
  ///   3. 单个 model 校验失败: 每条一个 ConfigError, 该 model 不入 configs
  static Future<ConfigValidationResult> loadAllDetailed() async {
    if (_lastResult != null) return _lastResult!;

    final errors = <ConfigError>[];

    try {
      final configPath = await _resolveConfigPath();
      if (configPath == null) {
        errors.add(ConfigError(
          modelKey: '<file>',
          field: 'path',
          reason: 'device-config.json not found in any candidate location',
        ));
        _lastResult = ConfigValidationResult(
          configs: _loadDefaults(),
          errors: errors,
        );
        return _lastResult!;
      }

      final file = File(configPath);
      if (!await file.exists()) {
        errors.add(ConfigError(
          modelKey: '<file>',
          field: 'path',
          reason: 'config file does not exist: $configPath',
        ));
        _lastResult = ConfigValidationResult(
          configs: _loadDefaults(),
          errors: errors,
        );
        return _lastResult!;
      }

      final content = await file.readAsString();
      Map<String, dynamic> json;
      try {
        json = jsonDecode(content) as Map<String, dynamic>;
      } on FormatException catch (e) {
        errors.add(ConfigError(
          modelKey: '<file>',
          field: 'json',
          reason: 'JSON parse error: ${e.message}',
          rawValue: e.offset,
        ));
        _lastResult = ConfigValidationResult(
          configs: _loadDefaults(),
          errors: errors,
        );
        return _lastResult!;
      }

      // s1.6: 顶层结构校验
      if (json['models'] is! Map<String, dynamic>) {
        errors.add(ConfigError(
          modelKey: '<file>',
          field: 'models',
          reason: 'expected object map, got ${json['models'].runtimeType}',
          rawValue: json['models'],
        ));
        _lastResult = ConfigValidationResult(
          configs: _loadDefaults(),
          errors: errors,
        );
        return _lastResult!;
      }

      final models = json['models'] as Map<String, dynamic>;

      // s1.6: 校验外层 key 与内部 key 字段一致 (避免错位)
      for (final entry in models.entries) {
        if (entry.value is! Map<String, dynamic>) {
          errors.add(ConfigError(
            modelKey: entry.key,
            field: '<root>',
            reason: 'expected object, got ${entry.value.runtimeType}',
            rawValue: entry.value,
          ));
          continue;
        }
        final inner = entry.value as Map<String, dynamic>;
        final innerKey = inner['key'] as String?;
        if (innerKey != null && innerKey != entry.key) {
          errors.add(ConfigError(
            modelKey: entry.key,
            field: 'key',
            reason: 'outer key "${entry.key}" != inner key "$innerKey"',
            rawValue: innerKey,
          ));
        }
      }

      // s1.6: 逐个 model 反序列化
      final result = <String, DeviceModelConfig>{};
      final seenKeys = <String>{};
      for (final entry in models.entries) {
        if (entry.value is! Map<String, dynamic>) continue; // 上面已记录错误
        try {
          final cfg = DeviceModelConfig.fromJson(
            entry.value as Map<String, dynamic>,
            errors,
            outerKey: entry.key,
          );
          if (cfg == null) continue; // 必填字段缺失, 已记录

          // s1.6: 唯一性检查
          if (seenKeys.contains(cfg.key)) {
            errors.add(ConfigError(
              modelKey: cfg.key,
              field: 'key',
              reason: 'duplicate key in models map',
              rawValue: cfg.key,
            ));
            continue;
          }
          seenKeys.add(cfg.key);
          result[cfg.key] = cfg;
        } catch (e) {
          // fromJson 内部不应抛, 但万一: 兜底记录
          errors.add(ConfigError(
            modelKey: entry.key,
            field: '<root>',
            reason: 'unexpected fromJson exception: $e',
            rawValue: e,
          ));
        }
      }

      _cache = result;
      _lastResult = ConfigValidationResult(configs: result, errors: errors);
      return _lastResult!;
    } catch (e, st) {
      // 兜底: 任何意外错误
      errors.add(ConfigError(
        modelKey: '<file>',
        field: '<root>',
        reason: 'unexpected loader exception: $e',
        rawValue: '$st',
      ));
      _lastResult = ConfigValidationResult(
        configs: _loadDefaults(),
        errors: errors,
      );
      return _lastResult!;
    }
  }

  /// s1.6: 暴露最近一次校验的错误 (供 IPC 端点 / 调试)
  static List<ConfigError> getLastErrors() {
    return _lastResult?.errors ?? const [];
  }

  /// s1.6: 最近一次校验的结果
  static ConfigValidationResult? getLastValidation() {
    return _lastResult;
  }

  /// 解析 device-config.json 实际位置
  ///
  /// 优先顺序:
  ///   1. 主进程 --models-dir 显式传入 (最稳,生产推荐)
  ///   2. 环境变量 SOLOFORGE_MODELS_DIR
  ///   3. exe 旁 ./models/ (开发模式,canvas-dist 跟 models 同级)
  ///   4. exe 上级 ../models/ (项目结构,canvas-dist 在 canvas/ 下)
  ///   5. exe 上上级 ../../models/ (打包后,canvas 在 release/win-unpacked/canvas/)
  static Future<String?> _resolveConfigPath() async {
    // 1. 显式注入
    if (_overrideDir != null) {
      return '$_overrideDir/device-config.json';
    }
    // 2. 环境变量
    final envDir = Platform.environment['SOLOFORGE_MODELS_DIR'];
    if (envDir != null && envDir.isNotEmpty) {
      return '$envDir/device-config.json';
    }
    // 3-5. 探测
    final exeDir = _getCanvasExeDir();
    final candidates = [
      '$exeDir/models/device-config.json',            // 旁
      '${_parent(exeDir)}/models/device-config.json', // 上级
      '${_parent(_parent(exeDir))}/models/device-config.json', // 上上级
    ];
    for (final p in candidates) {
      if (await File(p).exists()) return p;
    }
    return null;
  }

  static String _parent(String path) {
    // 用 forward slash 避免 Windows 反斜杠
    final parts = path.split(RegExp(r'[/\\]'));
    if (parts.isEmpty) return path;
    parts.removeLast();
    return parts.join('/');
  }

  /// 默认配置 (配置文件不可用时)
  static Map<String, DeviceModelConfig> _loadDefaults() {
    return {
      'fill': DeviceModelConfig(
        key: 'fill',
        label: '填满当前宽度',
        group: 'desktop',
        type: '2d',
        file: '',
        screenUV: const ScreenUV(
          blX: 0, blY: 0, brX: 1, brY: 0,
          trX: 1, trY: 1, tlX: 0, tlY: 1,
        ),
        nativeWidth: 0,
        nativeHeight: 0,
      ),
    };
  }

  static String _getCanvasExeDir() {
    final exe = Platform.resolvedExecutable;
    return File(exe).parent.path;
  }

  /// 通过 key 获取配置
  static Future<DeviceModelConfig?> getConfig(String key) async {
    final all = await loadAll();
    return all[key];
  }
}
