import 'package:flutter/material.dart';

enum UiNodeType {
  container,
  text,
  button,
  input,
  image,
  icon,
  chart,
  spacer,
  progress,
  divider,
}

enum FlexDirection {
  row,
  column,
  stack,
  zstack,
}

enum ChartType {
  bar,
  line,
  pie,
}

enum ButtonVariant {
  filled,
  outlined,
  text,
}

enum TextAlignment {
  left,
  center,
  right,
  start,
  end,
}

class UiNode {
  final UiNodeType type;
  final Map<String, dynamic> props;
  final List<UiNode> children;
  final List<UiNode Function(Map<String, dynamic>)>? dynamicChildren;

  UiNode({
    required this.type,
    this.props = const {},
    this.children = const [],
    this.dynamicChildren,
  });
}

class UiParser {
  static UiNode parse(Map<String, dynamic> json) {
    final typeStr = json['type'] as String? ?? 'container';
    final type = _parseType(typeStr);
    final props = json['props'] as Map<String, dynamic>? ?? {};
    final rawChildren = json['children'] as List<dynamic>?;

    final children = <UiNode>[];
    if (rawChildren != null) {
      for (final child in rawChildren) {
        if (child is Map<String, dynamic>) {
          children.add(parse(child));
        }
      }
    }

    return UiNode(type: type, props: props, children: children);
  }

  static UiNodeType _parseType(String type) {
    switch (type) {
      case 'container':
        return UiNodeType.container;
      case 'text':
        return UiNodeType.text;
      case 'button':
        return UiNodeType.button;
      case 'input':
        return UiNodeType.input;
      case 'image':
        return UiNodeType.image;
      case 'icon':
        return UiNodeType.icon;
      case 'chart':
        return UiNodeType.chart;
      case 'spacer':
        return UiNodeType.spacer;
      case 'progress':
        return UiNodeType.progress;
      case 'divider':
        return UiNodeType.divider;
      default:
        return UiNodeType.container;
    }
  }

  static Color parseColor(dynamic value, [Color defaultColor = const Color(0xFF000000)]) {
    if (value == null) return defaultColor;
    if (value is String) {
      if (value.startsWith('#')) {
        final hex = value.substring(1);
        if (hex.length == 6) {
          return Color(int.parse('FF$hex', radix: 16));
        } else if (hex.length == 8) {
          return Color(int.parse(hex, radix: 16));
        }
      }
      if (value.startsWith('0x')) {
        return Color(int.parse(value.substring(2), radix: 16));
      }
    }
    if (value is int) {
      return Color(value);
    }
    return defaultColor;
  }

  static double parseDouble(dynamic value, [double defaultValue = 0.0]) {
    if (value == null) return defaultValue;
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value) ?? defaultValue;
    return defaultValue;
  }

  static int parseInt(dynamic value, [int defaultValue = 0]) {
    if (value == null) return defaultValue;
    if (value is num) return value.toInt();
    if (value is String) return int.tryParse(value) ?? defaultValue;
    return defaultValue;
  }

  static bool parseBool(dynamic value, [bool defaultValue = false]) {
    if (value == null) return defaultValue;
    if (value is bool) return value;
    if (value is String) {
      if (value == 'true' || value == '1') return true;
      if (value == 'false' || value == '0') return false;
    }
    if (value is num) return value != 0;
    return defaultValue;
  }

  static FontWeight parseFontWeight(dynamic value, [FontWeight defaultValue = FontWeight.normal]) {
    if (value == null) return defaultValue;
    if (value is num) {
      final w = value.toInt();
      if (w >= 1 && w <= 9) return FontWeight.values[w - 1];
      final idx = (w ~/ 100) - 1;
      if (idx >= 0 && idx < FontWeight.values.length) return FontWeight.values[idx];
      return defaultValue;
    }
    if (value is String) {
      switch (value) {
        case 'w100': case 'thin': return FontWeight.w100;
        case 'w200': case 'extraLight': return FontWeight.w200;
        case 'w300': case 'light': return FontWeight.w300;
        case 'w400': case 'normal': case 'regular': return FontWeight.w400;
        case 'w500': case 'medium': return FontWeight.w500;
        case 'w600': case 'semiBold': return FontWeight.w600;
        case 'w700': case 'bold': return FontWeight.w700;
        case 'w800': case 'extraBold': return FontWeight.w800;
        case 'w900': case 'black': return FontWeight.w900;
      }
    }
    return defaultValue;
  }

  static TextAlign parseTextAlign(dynamic value, [TextAlign defaultValue = TextAlign.start]) {
    if (value == null) return defaultValue;
    if (value is String) {
      switch (value) {
        case 'left': return TextAlign.left;
        case 'center': return TextAlign.center;
        case 'right': return TextAlign.right;
        case 'start': return TextAlign.start;
        case 'end': return TextAlign.end;
      }
    }
    return defaultValue;
  }

  static FlexDirection parseFlexDirection(dynamic value, [FlexDirection defaultValue = FlexDirection.column]) {
    if (value == null) return defaultValue;
    if (value is String) {
      switch (value) {
        case 'row': return FlexDirection.row;
        case 'column': return FlexDirection.column;
        case 'stack': return FlexDirection.stack;
        case 'zstack': return FlexDirection.zstack;
      }
    }
    return defaultValue;
  }

  static ChartType parseChartType(dynamic value, [ChartType defaultValue = ChartType.bar]) {
    if (value == null) return defaultValue;
    if (value is String) {
      switch (value) {
        case 'bar': return ChartType.bar;
        case 'line': return ChartType.line;
        case 'pie': return ChartType.pie;
      }
    }
    return defaultValue;
  }

  static ButtonVariant parseButtonVariant(dynamic value, [ButtonVariant defaultValue = ButtonVariant.filled]) {
    if (value == null) return defaultValue;
    if (value is String) {
      switch (value) {
        case 'filled': return ButtonVariant.filled;
        case 'outlined': return ButtonVariant.outlined;
        case 'text': return ButtonVariant.text;
      }
    }
    return defaultValue;
  }

  static Alignment parseAlignment(dynamic value, [Alignment defaultValue = Alignment.center]) {
    if (value == null) return defaultValue;
    if (value is String) {
      switch (value) {
        case 'topLeft': return Alignment.topLeft;
        case 'topCenter': case 'top': return Alignment.topCenter;
        case 'topRight': return Alignment.topRight;
        case 'centerLeft': return Alignment.centerLeft;
        case 'center': return Alignment.center;
        case 'centerRight': return Alignment.centerRight;
        case 'bottomLeft': return Alignment.bottomLeft;
        case 'bottomCenter': case 'bottom': return Alignment.bottomCenter;
        case 'bottomRight': return Alignment.bottomRight;
      }
    }
    return defaultValue;
  }

  static MainAxisAlignment parseMainAxisAlignment(dynamic value, [MainAxisAlignment defaultValue = MainAxisAlignment.start]) {
    if (value == null) return defaultValue;
    if (value is String) {
      switch (value) {
        case 'start': return MainAxisAlignment.start;
        case 'center': return MainAxisAlignment.center;
        case 'end': return MainAxisAlignment.end;
        case 'spaceBetween': return MainAxisAlignment.spaceBetween;
        case 'spaceAround': return MainAxisAlignment.spaceAround;
        case 'spaceEvenly': return MainAxisAlignment.spaceEvenly;
      }
    }
    return defaultValue;
  }

  static CrossAxisAlignment parseCrossAxisAlignment(dynamic value, [CrossAxisAlignment defaultValue = CrossAxisAlignment.center]) {
    if (value == null) return defaultValue;
    if (value is String) {
      switch (value) {
        case 'start': return CrossAxisAlignment.start;
        case 'center': return CrossAxisAlignment.center;
        case 'end': return CrossAxisAlignment.end;
        case 'stretch': return CrossAxisAlignment.stretch;
        case 'baseline': return CrossAxisAlignment.baseline;
      }
    }
    return defaultValue;
  }

  static EdgeInsets parseEdgeInsets(dynamic value, [EdgeInsets defaultValue = EdgeInsets.zero]) {
    if (value == null) return defaultValue;
    if (value is num) return EdgeInsets.all(value.toDouble());
    if (value is String) {
      final parts = value.split(',').map((s) => double.tryParse(s.trim()) ?? 0.0).toList();
      if (parts.length == 1) return EdgeInsets.all(parts[0]);
      if (parts.length == 2) return EdgeInsets.symmetric(vertical: parts[0], horizontal: parts[1]);
      if (parts.length == 4) return EdgeInsets.fromLTRB(parts[0], parts[1], parts[2], parts[3]);
    }
    if (value is Map<String, dynamic>) {
      final left = parseDouble(value['left']);
      final top = parseDouble(value['top']);
      final right = parseDouble(value['right']);
      final bottom = parseDouble(value['bottom']);
      if (left != 0 || top != 0 || right != 0 || bottom != 0) {
        return EdgeInsets.fromLTRB(left, top, right, bottom);
      }
      final all = parseDouble(value['all']);
      if (all != 0) return EdgeInsets.all(all);
      final h = parseDouble(value['horizontal']);
      final v = parseDouble(value['vertical']);
      if (h != 0 || v != 0) return EdgeInsets.symmetric(horizontal: h, vertical: v);
    }
    return defaultValue;
  }

  static List<ChartDataPoint> parseChartData(dynamic value) {
    final points = <ChartDataPoint>[];
    if (value is List) {
      for (final item in value) {
        if (item is Map<String, dynamic>) {
          points.add(ChartDataPoint(
            label: item['label'] as String? ?? '',
            value: parseDouble(item['value']),
            color: item.containsKey('color') ? parseColor(item['color']) : null,
          ));
        }
      }
    }
    return points;
  }
}

class ChartDataPoint {
  final String label;
  final double value;
  final Color? color;

  ChartDataPoint({
    required this.label,
    required this.value,
    this.color,
  });
}
