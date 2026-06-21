import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'ui_parser.dart';

class PlatformRenderer {
  final String mode;

  PlatformRenderer(this.mode);

  Widget build(UiNode node, BuildContext context) {
    switch (mode) {
      case 'fluent':
        return _buildFluent(node, context);
      case 'chart':
        return _buildChart(node, context);
      default:
        return _buildMaterial(node, context);
    }
  }

  Widget _buildMaterial(UiNode node, BuildContext context) {
    return _buildNode(node, context, _materialBuilder);
  }

  Widget _buildFluent(UiNode node, BuildContext context) {
    return _buildNode(node, context, _fluentBuilder);
  }

  Widget _buildChart(UiNode node, BuildContext context) {
    return _buildNode(node, context, _chartBuilder);
  }

  Widget _buildNode(UiNode node, BuildContext context, Widget Function(UiNode, BuildContext) builder) {
    final visible = UiParser.parseBool(node.props['visible'], true);
    if (!visible) return const SizedBox.shrink();

    final opacity = UiParser.parseDouble(node.props['opacity'], 1.0);
    Widget widget = builder(node, context);

    if (opacity < 1.0) {
      widget = Opacity(opacity: opacity, child: widget);
    }

    final margin = UiParser.parseEdgeInsets(node.props['margin']);
    if (margin != EdgeInsets.zero) {
      widget = Padding(padding: margin, child: widget);
    }

    return widget;
  }

  Widget _applyContainerProps(Widget child, Map<String, dynamic> props) {
    Widget widget = child;

    final padding = UiParser.parseEdgeInsets(props['padding']);
    if (padding != EdgeInsets.zero) {
      widget = Padding(padding: padding, child: widget);
    }

    final bgColor = UiParser.parseColor(props['backgroundColor'], Colors.transparent);
    final borderRadius = UiParser.parseDouble(props['borderRadius']);
    final borderWidth = UiParser.parseDouble(props['borderWidth']);
    final borderColor = UiParser.parseColor(props['borderColor']);

    if (bgColor != Colors.transparent || borderRadius > 0 || borderWidth > 0) {
      widget = Container(
        decoration: BoxDecoration(
          color: bgColor,
          borderRadius: borderRadius > 0 ? BorderRadius.circular(borderRadius) : null,
          border: borderWidth > 0 ? Border.all(color: borderColor, width: borderWidth) : null,
        ),
        child: widget,
      );
    }

    final width = UiParser.parseDouble(props['width']);
    final height = UiParser.parseDouble(props['height']);
    if (width > 0 || height > 0) {
      widget = SizedBox(
        width: width > 0 ? width : null,
        height: height > 0 ? height : null,
        child: widget,
      );
    }

    final alignment = UiParser.parseAlignment(props['alignment']);
    if (alignment != Alignment.center) {
      widget = Align(alignment: alignment, child: widget);
    }

    return widget;
  }

  List<Widget> _buildChildren(UiNode node, BuildContext context, Widget Function(UiNode, BuildContext) builder) {
    return node.children.map((child) => _buildNode(child, context, builder)).toList();
  }

  Widget _buildContainer(UiNode node, BuildContext context, Widget Function(UiNode, BuildContext) builder) {
    final direction = UiParser.parseFlexDirection(node.props['layout']);
    final children = _buildChildren(node, context, builder);

    Widget container;
    switch (direction) {
      case FlexDirection.row:
        final spacing = UiParser.parseDouble(node.props['spacing']);
        final mainAxis = UiParser.parseMainAxisAlignment(node.props['mainAxisAlignment']);
        final crossAxis = UiParser.parseCrossAxisAlignment(node.props['crossAxisAlignment']);
        container = Row(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: mainAxis,
          crossAxisAlignment: crossAxis,
          children: spacing > 0
              ? _separateChildren(children, SizedBox(width: spacing))
              : children,
        );
      case FlexDirection.column:
        final spacing = UiParser.parseDouble(node.props['spacing']);
        final mainAxis = UiParser.parseMainAxisAlignment(node.props['mainAxisAlignment']);
        final crossAxis = UiParser.parseCrossAxisAlignment(node.props['crossAxisAlignment']);
        container = Column(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: mainAxis,
          crossAxisAlignment: crossAxis,
          children: spacing > 0
              ? _separateChildren(children, SizedBox(height: spacing))
              : children,
        );
      case FlexDirection.stack:
      case FlexDirection.zstack:
        container = Stack(
          alignment: UiParser.parseAlignment(node.props['alignment']),
          children: children,
        );
    }

    return _applyContainerProps(container, node.props);
  }

  List<Widget> _separateChildren(List<Widget> children, Widget separator) {
    if (children.isEmpty) return children;
    final result = <Widget>[children[0]];
    for (int i = 1; i < children.length; i++) {
      result.add(separator);
      result.add(children[i]);
    }
    return result;
  }

  Widget _buildText(UiNode node, BuildContext context, TextStyle? baseStyle) {
    final content = node.props['content'] as String? ?? '';
    final fontSize = UiParser.parseDouble(node.props['fontSize'], 14);
    final color = UiParser.parseColor(node.props['color'], const Color(0xFF1C1B1F));
    final fontWeight = UiParser.parseFontWeight(node.props['fontWeight']);
    final textAlign = UiParser.parseTextAlign(node.props['textAlign']);
    final maxLinesValue = node.props['maxLines'];
    final maxLines = maxLinesValue is int ? maxLinesValue : (maxLinesValue is String ? int.tryParse(maxLinesValue) : null);
    final overflow = UiParser.parseBool(node.props['ellipsis'], true) ? TextOverflow.ellipsis : null;

    final style = (baseStyle ?? const TextStyle()).copyWith(
      fontSize: fontSize,
      color: color,
      fontWeight: fontWeight,
    );

    Widget text = Text(
      content,
      style: style,
      textAlign: textAlign,
      maxLines: maxLines,
      overflow: overflow,
    );

    return _applyContainerProps(text, node.props);
  }

  Widget _buildButton(UiNode node, BuildContext context, ButtonStyle Function(ButtonVariant, Color)? styleBuilder) {
    final label = node.props['label'] as String? ?? '';
    final variant = UiParser.parseButtonVariant(node.props['variant']);
    final disabled = UiParser.parseBool(node.props['disabled']);
    final color = UiParser.parseColor(node.props['color'], const Color(0xFF6750A4));

    final onPressed = disabled ? null : () {};

    Widget button;

    if (styleBuilder != null) {
      final customStyle = styleBuilder(variant, color);
      switch (variant) {
        case ButtonVariant.filled:
          button = ElevatedButton(
            style: customStyle,
            onPressed: onPressed,
            child: Text(label),
          );
        case ButtonVariant.outlined:
          button = OutlinedButton(
            style: customStyle,
            onPressed: onPressed,
            child: Text(label),
          );
        case ButtonVariant.text:
          button = TextButton(
            style: customStyle,
            onPressed: onPressed,
            child: Text(label),
          );
      }
    } else {
      switch (variant) {
        case ButtonVariant.filled:
          button = ElevatedButton(
            onPressed: onPressed,
            style: ElevatedButton.styleFrom(backgroundColor: color),
            child: Text(label),
          );
        case ButtonVariant.outlined:
          button = OutlinedButton(
            onPressed: onPressed,
            style: OutlinedButton.styleFrom(foregroundColor: color, side: BorderSide(color: color)),
            child: Text(label),
          );
        case ButtonVariant.text:
          button = TextButton(
            onPressed: onPressed,
            style: TextButton.styleFrom(foregroundColor: color),
            child: Text(label),
          );
      }
    }

    return _applyContainerProps(button, node.props);
  }

  Widget _buildInput(UiNode node, BuildContext context, InputDecoration Function()? decorationBuilder) {
    final placeholder = node.props['placeholder'] as String? ?? '';
    final value = node.props['value'] as String? ?? '';
    final obscureText = UiParser.parseBool(node.props['obscureText']);
    final maxLines = UiParser.parseInt(node.props['maxLines'], 1);
    final color = UiParser.parseColor(node.props['color']);

    Widget input = TextField(
      obscureText: obscureText,
      maxLines: maxLines,
      controller: TextEditingController.fromValue(
        TextEditingValue(text: value, selection: TextSelection.collapsed(offset: value.length)),
      ),
      decoration: decorationBuilder != null
          ? decorationBuilder()
          : InputDecoration(
              hintText: placeholder,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(4),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(4),
                borderSide: BorderSide(color: color != Colors.transparent ? color : const Color(0xFF6750A4), width: 2),
              ),
              contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              isDense: true,
            ),
    );

    return _applyContainerProps(input, node.props);
  }

  Widget _buildImage(UiNode node, BuildContext context) {
    final url = node.props['url'] as String?;
    final fitStr = node.props['fit'] as String?;
    BoxFit? fit;
    if (fitStr != null) {
      switch (fitStr) {
        case 'fill': fit = BoxFit.fill;
        case 'contain': fit = BoxFit.contain;
        case 'cover': fit = BoxFit.cover;
        case 'fitWidth': fit = BoxFit.fitWidth;
        case 'fitHeight': fit = BoxFit.fitHeight;
        case 'none': fit = BoxFit.none;
        case 'scaleDown': fit = BoxFit.scaleDown;
      }
    }

    Widget image;
    if (url != null && url.isNotEmpty) {
      image = Image.network(
        url,
        fit: fit,
        errorBuilder: (_, __, ___) => const Icon(Icons.broken_image, size: 48),
        loadingBuilder: (_, child, progress) {
          if (progress == null) return child;
          return const Center(child: CircularProgressIndicator(strokeWidth: 2));
        },
      );
    } else {
      image = const Icon(Icons.image, size: 48, color: Color(0xFFBDBDBD));
    }

    return _applyContainerProps(image, node.props);
  }

  Widget _buildIcon(UiNode node, BuildContext context) {
    final iconName = node.props['icon'] as String? ?? 'star';
    final size = UiParser.parseDouble(node.props['size'], 24);
    final color = UiParser.parseColor(node.props['color'], const Color(0xFF1C1B1F));

    IconData iconData = _resolveIcon(iconName);
    Widget icon = Icon(iconData, size: size, color: color);
    return _applyContainerProps(icon, node.props);
  }

  IconData _resolveIcon(String name) {
    switch (name) {
      case 'add': return Icons.add;
      case 'arrow_back': return Icons.arrow_back;
      case 'arrow_forward': return Icons.arrow_forward;
      case 'arrow_upward': return Icons.arrow_upward;
      case 'arrow_downward': return Icons.arrow_downward;
      case 'check': return Icons.check;
      case 'close': return Icons.close;
      case 'delete': return Icons.delete;
      case 'edit': return Icons.edit;
      case 'email': return Icons.email;
      case 'favorite': return Icons.favorite;
      case 'home': return Icons.home;
      case 'info': return Icons.info;
      case 'menu': return Icons.menu;
      case 'more_vert': return Icons.more_vert;
      case 'person': return Icons.person;
      case 'search': return Icons.search;
      case 'settings': return Icons.settings;
      case 'share': return Icons.share;
      case 'star': return Icons.star;
      case 'warning': return Icons.warning;
      case 'refresh': return Icons.refresh;
      case 'download': return Icons.download;
      case 'upload': return Icons.upload;
      case 'play_arrow': return Icons.play_arrow;
      case 'pause': return Icons.pause;
      default: return Icons.circle;
    }
  }

  Widget _buildSpacer(UiNode node, BuildContext context) {
    final flex = UiParser.parseInt(node.props['flex'], 1);
    return Spacer(flex: flex);
  }

  Widget _buildProgress(UiNode node, BuildContext context) {
    final value = UiParser.parseDouble(node.props['value']);
    final indeterminate = value <= 0;
    final color = UiParser.parseColor(node.props['color'], const Color(0xFF6750A4));

    Widget progress;
    if (indeterminate) {
      progress = LinearProgressIndicator(
        backgroundColor: color.withOpacity(0.12),
        color: color,
      );
    } else {
      progress = LinearProgressIndicator(
        value: value.clamp(0.0, 1.0),
        backgroundColor: color.withOpacity(0.12),
        color: color,
      );
    }

    return _applyContainerProps(progress, node.props);
  }

  Widget _buildDivider(UiNode node, BuildContext context) {
    final thickness = UiParser.parseDouble(node.props['thickness'], 1);
    final color = UiParser.parseColor(node.props['color'], const Color(0xFFE0E0E0));
    return Divider(thickness: thickness, color: color, height: thickness);
  }

  Widget _buildChartWidget(UiNode node, BuildContext context) {
    final chartType = UiParser.parseChartType(node.props['chartType']);
    final title = node.props['title'] as String?;
    final data = UiParser.parseChartData(node.props['data']);
    final colors = node.props['colors'] as List<dynamic>?;

    final chartColors = <Color>[
      const Color(0xFF6750A4),
      const Color(0xFF9C27B0),
      const Color(0xFFE91E63),
      const Color(0xFFFF5722),
      const Color(0xFFFF9800),
      const Color(0xFFFFC107),
      const Color(0xFF4CAF50),
      const Color(0xFF2196F3),
      const Color(0xFF00BCD4),
      const Color(0xFF607D8B),
    ];

    if (colors != null) {
      for (int i = 0; i < colors.length && i < chartColors.length; i++) {
        if (colors[i] is String) {
          chartColors[i] = UiParser.parseColor(colors[i]);
        }
      }
    }

    Widget chartWidget;
    switch (chartType) {
      case ChartType.bar:
        chartWidget = _BarChartWidget(data: data, colors: chartColors);
      case ChartType.line:
        chartWidget = _LineChartWidget(data: data, color: chartColors.isNotEmpty ? chartColors[0] : const Color(0xFF6750A4));
      case ChartType.pie:
        chartWidget = _PieChartWidget(data: data, colors: chartColors);
    }

    if (title != null && title.isNotEmpty) {
      chartWidget = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              title,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: Color(0xFF1C1B1F)),
            ),
          ),
          Expanded(child: chartWidget),
        ],
      );
    }

    return _applyContainerProps(chartWidget, node.props);
  }

  Widget _materialBuilder(UiNode node, BuildContext context) {
    switch (node.type) {
      case UiNodeType.container:
        return _buildContainer(node, context, _materialBuilder);
      case UiNodeType.text:
        return _buildText(node, context, Theme.of(context).textTheme.bodyMedium);
      case UiNodeType.button:
        return _buildButton(node, context, null);
      case UiNodeType.input:
        return _buildInput(node, context, null);
      case UiNodeType.image:
        return _buildImage(node, context);
      case UiNodeType.icon:
        return _buildIcon(node, context);
      case UiNodeType.chart:
        return _buildChartWidget(node, context);
      case UiNodeType.spacer:
        return _buildSpacer(node, context);
      case UiNodeType.progress:
        return _buildProgress(node, context);
      case UiNodeType.divider:
        return _buildDivider(node, context);
    }
  }

  Widget _fluentBuilder(UiNode node, BuildContext context) {
    switch (node.type) {
      case UiNodeType.container:
        return _buildContainer(node, context, _fluentBuilder);
      case UiNodeType.text:
        return _buildText(node, context, const TextStyle(
          fontFamily: 'Segoe UI',
          color: Color(0xFF1C1B1F),
        ));
      case UiNodeType.button:
        return _buildButton(node, context, _fluentButtonStyle);
      case UiNodeType.input:
        return _buildInput(node, context, () {
          final color = UiParser.parseColor(node.props['color']);
          return InputDecoration(
            hintText: node.props['placeholder'] as String? ?? '',
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(2),
              borderSide: const BorderSide(color: Color(0xFF8A8886)),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(2),
              borderSide: const BorderSide(color: Color(0xFF8A8886)),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(2),
              borderSide: BorderSide(
                color: color != Colors.transparent ? color : const Color(0xFF0067C0),
                width: 1.5,
              ),
            ),
            contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            isDense: true,
          );
        });
      case UiNodeType.image:
        return _buildImage(node, context);
      case UiNodeType.icon:
        return _buildIcon(node, context);
      case UiNodeType.chart:
        return _buildChartWidget(node, context);
      case UiNodeType.spacer:
        return _buildSpacer(node, context);
      case UiNodeType.progress:
        return _buildProgress(node, context);
      case UiNodeType.divider:
        return _buildDivider(node, context);
    }
  }

  ButtonStyle _fluentButtonStyle(ButtonVariant variant, Color color) {
    final accent = color != const Color(0xFF6750A4) ? color : const Color(0xFF0067C0);
    final borderRadius = BorderRadius.circular(2);

    switch (variant) {
      case ButtonVariant.filled:
        return ElevatedButton.styleFrom(
          backgroundColor: accent,
          foregroundColor: Colors.white,
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          shape: RoundedRectangleBorder(borderRadius: borderRadius),
          textStyle: const TextStyle(
            fontFamily: 'Segoe UI',
            fontSize: 14,
            fontWeight: FontWeight.w400,
          ),
        );
      case ButtonVariant.outlined:
        return OutlinedButton.styleFrom(
          foregroundColor: accent,
          side: BorderSide(color: accent),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          shape: RoundedRectangleBorder(borderRadius: borderRadius),
          textStyle: const TextStyle(
            fontFamily: 'Segoe UI',
            fontSize: 14,
            fontWeight: FontWeight.w400,
          ),
        );
      case ButtonVariant.text:
        return TextButton.styleFrom(
          foregroundColor: accent,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          shape: RoundedRectangleBorder(borderRadius: borderRadius),
          textStyle: const TextStyle(
            fontFamily: 'Segoe UI',
            fontSize: 14,
            fontWeight: FontWeight.w400,
          ),
        );
    }
  }

  Widget _chartBuilder(UiNode node, BuildContext context) {
    switch (node.type) {
      case UiNodeType.container:
        return _buildContainer(node, context, _chartBuilder);
      case UiNodeType.text:
        return _buildText(node, context, const TextStyle(fontSize: 14, color: Color(0xFF1C1B1F)));
      case UiNodeType.button:
        return _buildButton(node, context, null);
      case UiNodeType.input:
        return _buildInput(node, context, null);
      case UiNodeType.image:
        return _buildImage(node, context);
      case UiNodeType.icon:
        return _buildIcon(node, context);
      case UiNodeType.chart:
        return _buildChartWidget(node, context);
      case UiNodeType.spacer:
        return _buildSpacer(node, context);
      case UiNodeType.progress:
        return _buildProgress(node, context);
      case UiNodeType.divider:
        return _buildDivider(node, context);
    }
  }
}

class _BarChartWidget extends StatelessWidget {
  final List<ChartDataPoint> data;
  final List<Color> colors;

  const _BarChartWidget({required this.data, required this.colors});

  @override
  Widget build(BuildContext context) {
    if (data.isEmpty) return const SizedBox.shrink();

    final maxValue = data.map((p) => p.value).reduce(math.max);
    final barCount = data.length;

    return LayoutBuilder(
      builder: (context, constraints) {
        final barWidth = (constraints.maxWidth / barCount) * 0.6;
        final spacing = (constraints.maxWidth / barCount) * 0.4;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: List.generate(barCount, (i) {
                  final point = data[i];
                  final barHeight = maxValue > 0 ? (point.value / maxValue) * constraints.maxHeight : 0.0;
                  final color = point.color ?? colors[i % colors.length];

                  return Expanded(
                    child: Container(
                      margin: EdgeInsets.only(right: i < barCount - 1 ? spacing : 0),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          Container(
                            width: barWidth,
                            height: barHeight.clamp(0.0, constraints.maxHeight),
                            decoration: BoxDecoration(
                              color: color,
                              borderRadius: BorderRadius.vertical(top: Radius.circular(2)),
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                }),
              ),
            ),
            const SizedBox(height: 4),
            Row(
              children: List.generate(barCount, (i) {
                final point = data[i];
                return Expanded(
                  child: Padding(
                    padding: EdgeInsets.only(right: i < barCount - 1 ? spacing : 0),
                    child: Text(
                      point.label,
                      textAlign: TextAlign.center,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 10, color: Color(0xFF666666)),
                    ),
                  ),
                );
              }),
            ),
          ],
        );
      },
    );
  }
}

class _LineChartWidget extends StatelessWidget {
  final List<ChartDataPoint> data;
  final Color color;

  const _LineChartWidget({required this.data, required this.color});

  @override
  Widget build(BuildContext context) {
    if (data.isEmpty) return const SizedBox.shrink();

    return CustomPaint(
      size: Size.infinite,
      painter: _LineChartPainter(data, color),
    );
  }
}

class _LineChartPainter extends CustomPainter {
  final List<ChartDataPoint> data;
  final Color color;

  _LineChartPainter(this.data, this.color);

  @override
  void paint(Canvas canvas, Size size) {
    if (data.isEmpty) return;

    final paint = Paint()
      ..color = color
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    final fillPaint = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [color.withOpacity(0.3), color.withOpacity(0.0)],
      ).createShader(Rect.fromLTWH(0, 0, size.width, size.height));

    final dotPaint = Paint()
      ..color = color
      ..style = PaintingStyle.fill;

    final maxValue = data.map((p) => p.value).reduce(math.max);
    final minValue = 0.0;
    final range = maxValue - minValue;
    final padding = 16.0;
    final chartWidth = size.width - padding * 2;
    final chartHeight = size.height - padding * 2;

    if (data.length < 2 || range == 0) return;

    final points = <Offset>[];
    for (int i = 0; i < data.length; i++) {
      final x = padding + (i / (data.length - 1)) * chartWidth;
      final y = padding + chartHeight - ((data[i].value - minValue) / range) * chartHeight;
      points.add(Offset(x, y));
    }

    final path = Path();
    path.moveTo(points.first.dx, points.first.dy);
    for (int i = 1; i < points.length; i++) {
      final xc = (points[i].dx + points[i - 1].dx) / 2;
      final yc = (points[i].dy + points[i - 1].dy) / 2;
      path.quadraticBezierTo(points[i - 1].dx, points[i - 1].dy, xc, yc);
    }
    path.lineTo(points.last.dx, points.last.dy);

    canvas.drawPath(path, paint);

    final fillPath = Path.from(path);
    fillPath.lineTo(points.last.dx, size.height - padding);
    fillPath.lineTo(points.first.dx, size.height - padding);
    fillPath.close();
    canvas.drawPath(fillPath, fillPaint);

    for (final point in points) {
      canvas.drawCircle(point, 3, dotPaint);
      canvas.drawCircle(point, 2, Paint()..color = Colors.white);
    }

    final textPainter = TextPainter(textDirection: TextDirection.ltr);
    for (int i = 0; i < data.length; i++) {
      if (data.length <= 12 || i % (data.length ~/ 6 + 1).clamp(1, 100) == 0) {
        textPainter.text = TextSpan(
          text: data[i].label,
          style: const TextStyle(fontSize: 9, color: Color(0xFF888888)),
        );
        textPainter.layout(maxWidth: 40);
        textPainter.paint(canvas, Offset(points[i].dx - textPainter.width / 2, size.height - padding + 4));
      }
    }
  }

  @override
  bool shouldRepaint(covariant _LineChartPainter old) => old.data != data || old.color != color;
}

class _PieChartWidget extends StatelessWidget {
  final List<ChartDataPoint> data;
  final List<Color> colors;

  const _PieChartWidget({required this.data, required this.colors});

  @override
  Widget build(BuildContext context) {
    if (data.isEmpty) return const SizedBox.shrink();

    final total = data.map((p) => p.value).reduce((a, b) => a + b);

    return Row(
      children: [
        Expanded(
          flex: 3,
          child: CustomPaint(
            size: const Size(150, 150),
            painter: _PieChartPainter(data, colors, total),
          ),
        ),
        Expanded(
          flex: 2,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: List.generate(data.length, (i) {
              final point = data[i];
              final color = point.color ?? colors[i % colors.length];
              final percentage = total > 0 ? (point.value / total * 100) : 0.0;
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  children: [
                    Container(
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(
                        color: color,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        point.label,
                        style: const TextStyle(fontSize: 11, color: Color(0xFF444444)),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    Text(
                      '${percentage.toStringAsFixed(1)}%',
                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w500, color: Color(0xFF1C1B1F)),
                    ),
                  ],
                ),
              );
            }),
          ),
        ),
      ],
    );
  }
}

class _PieChartPainter extends CustomPainter {
  final List<ChartDataPoint> data;
  final List<Color> colors;
  final double total;

  _PieChartPainter(this.data, this.colors, this.total);

  @override
  void paint(Canvas canvas, Size size) {
    if (data.isEmpty || total <= 0) return;

    final center = Offset(size.width / 2, size.height / 2);
    final radius = math.min(size.width, size.height) / 2 - 8;
    final rect = Rect.fromCircle(center: center, radius: radius);

    double startAngle = -math.pi / 2;

    for (int i = 0; i < data.length; i++) {
      final sweepAngle = (data[i].value / total) * 2 * math.pi;
      final color = data[i].color ?? colors[i % colors.length];

      final paint = Paint()
        ..color = color
        ..style = PaintingStyle.fill;

      canvas.drawArc(rect, startAngle, sweepAngle, true, paint);

      startAngle += sweepAngle;
    }

    canvas.drawCircle(center, radius * 0.45, Paint()..color = Colors.white);

    final textPainter = TextPainter(
      text: TextSpan(
        text: total.toStringAsFixed(0),
        style: const TextStyle(
          fontSize: 16,
          fontWeight: FontWeight.bold,
          color: Color(0xFF1C1B1F),
        ),
      ),
      textDirection: TextDirection.ltr,
    );
    textPainter.layout();
    textPainter.paint(canvas, center - Offset(textPainter.width / 2, textPainter.height / 2));
  }

  @override
  bool shouldRepaint(covariant _PieChartPainter old) => old.data != data || old.total != total;
}
