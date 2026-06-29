// Streaming methods delegate to StreamingASTParser (universal JSON payload stream).
// 旧 parse() API 仍工作,新 createStream/feedChunk/endStream/resetStream/parseUniversal/bestEffortRoot
// 全部可用,作为统一 facade.
import type { StreamState, UniversalNode } from './UniversalAST';
import {
  createStreamState,
  feedChunk as streamFeedChunk,
  markDone as streamMarkDone,
  resetStream as streamResetStream,
  parseOnce as streamParseOnce,
  bestEffortRoot as streamBestEffortRoot,
} from './StreamingASTParser';

export class ASTParser {
  parse(code: string, platform: 'material' | 'fluent' | 'chart'): string {
    const detectedPlatform = this.detectPlatform(code) || platform;
    const ast = this.parseWidget(code, detectedPlatform);
    return JSON.stringify(ast, null, 2);
  }

  // ─── Streaming facade (universal LLM JSON) ───

  /** 创建初始流状态 */
  createStream(): StreamState {
    return createStreamState();
  }

  /** 喂入一个 chunk, 返回新 state (纯函数) */
  feedChunk(state: StreamState, chunk: string): StreamState {
    return streamFeedChunk(state, chunk);
  }

  /** 标记流结束 */
  endStream(state: StreamState): StreamState {
    return streamMarkDone(state);
  }

  /** 重置流 */
  resetStream(): StreamState {
    return streamResetStream();
  }

  /** 单次解析 (非流式) */
  parseUniversal(raw: string): { payload: import('./UniversalAST').PreviewPayload | null; errors: string[] } {
    return streamParseOnce(raw);
  }

  /** 从 stream state 中尽量提取 root (半成品也行) */
  bestEffortRoot(state: StreamState): UniversalNode | undefined {
    return streamBestEffortRoot(state.payload);
  }

  // ─── 旧版 Flutter widget 解析 (private) ───

  private detectPlatform(code: string): 'material' | 'fluent' | 'chart' | null {
    const materialPatterns = /Scaffold|MaterialApp|ElevatedButton|AppBar|FloatingActionButton|Theme\(/;
    const fluentPatterns = /FluentTheme|CommandBar|NavigationView|NavigationPane|FluentButton|Acrylic|Reveal/;
    const chartPatterns = /BarChart|LineChart|PieChart|Chart\(|chartsflames|fl_chart|ChartCanvas/;

    if (chartPatterns.test(code)) return 'chart';
    if (fluentPatterns.test(code)) return 'fluent';
    if (materialPatterns.test(code)) return 'material';
    return null;
  }

  private parseWidget(code: string, platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    code = code.trim();

    if (code.startsWith('Scaffold(')) {
      return this.parseScaffold(code, platform);
    }
    if (code.startsWith('Container(')) {
      return this.parseContainer(code, platform);
    }
    if (code.startsWith('Row(')) {
      return this.parseRowOrColumn(code, 'row', platform);
    }
    if (code.startsWith('Column(')) {
      return this.parseRowOrColumn(code, 'column', platform);
    }
    if (code.startsWith('Stack(')) {
      return this.parseStack(code, platform);
    }
    if (code.startsWith('Center(')) {
      return this.parseCenter(code, platform);
    }
    if (code.startsWith('Padding(')) {
      return this.parsePadding(code, platform);
    }
    if (code.startsWith('SizedBox(')) {
      return this.parseSizedBox(code, platform);
    }
    if (code.startsWith('Text(')) {
      return this.parseText(code);
    }
    if (code.startsWith('ElevatedButton(') || code.startsWith('TextButton(') || code.startsWith('OutlinedButton(')) {
      return this.parseButton(code, platform);
    }
    if (code.startsWith('Icon(')) {
      return this.parseIcon(code);
    }
    if (code.startsWith('Image.network(') || code.startsWith('Image.asset(') || code.startsWith('Image.file(')) {
      return this.parseImage(code);
    }
    if (code.startsWith('ListView(') || code.startsWith('ListView.builder(')) {
      return this.parseListView(code, platform);
    }
    if (code.startsWith('AppBar(')) {
      return this.parseAppBar(code, platform);
    }
    if (code.startsWith('FloatingActionButton(')) {
      return this.parseFab(code, platform);
    }
    if (code.startsWith('FluentTheme(')) {
      return this.parseFluentTheme(code);
    }
    if (code.startsWith('CommandBar(')) {
      return this.parseCommandBar(code);
    }
    if (code.startsWith('NavigationView(')) {
      return this.parseNavigationView(code);
    }
    if (code.startsWith('BarChart(') || code.startsWith('LineChart(') || code.startsWith('PieChart(')) {
      return this.parseChart(code);
    }

    return { type: 'unknown', original: code.substring(0, 100) };
  }

  private extractChild(code: string): { child: Record<string, unknown> | null; rest: string } {
    const childMatch = code.match(/child:\s*(.+)$/);
    if (childMatch) {
      const childCode = this.balanceParens(childMatch[1]);
      if (childCode) {
        return { child: this.parseWidget(childCode, 'material'), rest: code.replace(childMatch[0], '') };
      }
    }
    return { child: null, rest: code };
  }

  private extractChildren(code: string): { children: Record<string, unknown>[]; rest: string } {
    const childrenMatch = code.match(/children:\s*\[([\s\S]*?)\]\s*[\),]/);
    if (childrenMatch) {
      const items = this.splitTopLevelCommas(childrenMatch[1]);
      const children = items.map((item) => this.parseWidget(item.trim(), 'material')).filter((c) => c.type !== 'unknown');
      return { children, rest: code.replace(childrenMatch[0], '') };
    }
    return { children: [], rest: code };
  }

  private extractProperties(code: string): Record<string, string> {
    const props: Record<string, string> = {};
    const propPatterns: [RegExp, string][] = [
      [/width:\s*([\d.]+)/, 'width'],
      [/height:\s*([\d.]+)/, 'height'],
      [/fontSize:\s*([\d.]+)/, 'fontSize'],
      [/padding:\s* EdgeInsets\.all\(([\d.]+)\)/, 'padding'],
      [/padding:\s* EdgeInsets\.symmetric\(([^)]+)\)/, 'padding'],
      [/margin:\s* EdgeInsets\.all\(([\d.]+)\)/, 'margin'],
      [/color:\s*Colors\.(\w+)/, 'color'],
      [/backgroundColor:\s*Colors\.(\w+)/, 'backgroundColor'],
      [/fontWeight:\s*FontWeight\.(\w+)/, 'fontWeight'],
      [/size:\s*([\d.]+)/, 'size'],
      [/radius:\s*BorderRadius\.circular\(([\d.]+)\)/, 'borderRadius'],
      [/mainAxisAlignment:\s*MainAxisAlignment\.(\w+)/, 'mainAxisAlignment'],
      [/crossAxisAlignment:\s*CrossAxisAlignment\.(\w+)/, 'crossAxisAlignment'],
      [/title:\s*Text\(['"]([^'"]+)['"]\)/, 'title'],
      [/icon:\s*Icon\(Icons\.(\w+)\)/, 'icon'],
      [/label:\s*['"]([^'"]+)['"]/, 'label'],
      [/fit:\s*BoxFit\.(\w+)/, 'fit'],
    ];

    for (const [regex, key] of propPatterns) {
      const match = code.match(regex);
      if (match) {
        props[key] = match[1];
      }
    }

    const colorHexMatch = code.match(/0x[0-9A-Fa-f]{8}/);
    if (colorHexMatch) {
      props['colorHex'] = colorHexMatch[0];
    }

    return props;
  }

  private parseContainer(code: string, platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    const props = this.extractProperties(code);
    const { child } = this.extractChild(code);
    const decoration = this.parseDecoration(code);

    const node: Record<string, unknown> = {
      type: 'container',
      platform,
      properties: props,
    };

    if (decoration) {
      node.decoration = decoration;
    }

    if (child) {
      node.child = child;
    }

    return node;
  }

  private parseDecoration(code: string): Record<string, unknown> | null {
    const boxMatch = code.match(/BoxDecoration\(([\s\S]*?)\)/);
    if (!boxMatch) return null;

    const deco: Record<string, unknown> = {};
    const colorMatch = boxMatch[1].match(/color:\s*Colors\.(\w+)/);
    if (colorMatch) {
      deco.color = colorMatch[1];
    }

    const borderMatch = boxMatch[1].match(/borderRadius:\s*BorderRadius\.circular\(([\d.]+)\)/);
    if (borderMatch) {
      deco.borderRadius = parseFloat(borderMatch[1]);
    }

    const gradientMatch = boxMatch[1].match(/gradient:\s*LinearGradient\(([\s\S]*?)\)/);
    if (gradientMatch) {
      deco.gradient = 'linear';
    }

    return Object.keys(deco).length > 0 ? deco : null;
  }

  private parseText(code: string): Record<string, unknown> {
    const textMatch = code.match(/Text\(['"]([^'"]+)['"]/);
    const text = textMatch ? textMatch[1] : '';

    const style: Record<string, unknown> = {};
    const styleMatch = code.match(/style:\s*TextStyle\(([\s\S]*?)\)/);
    if (styleMatch) {
      const fontSizeMatch = styleMatch[1].match(/fontSize:\s*([\d.]+)/);
      if (fontSizeMatch) style.fontSize = parseFloat(fontSizeMatch[1]);

      const colorMatch = styleMatch[1].match(/color:\s*Colors\.(\w+)/);
      if (colorMatch) style.color = colorMatch[1];

      const weightMatch = styleMatch[1].match(/fontWeight:\s*FontWeight\.(\w+)/);
      if (weightMatch) style.fontWeight = weightMatch[1];
    }

    return {
      type: 'text',
      properties: {
        data: text,
        ...(Object.keys(style).length > 0 ? { style } : {}),
      },
    };
  }

  private parseRowOrColumn(code: string, direction: 'row' | 'column', platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    const props = this.extractProperties(code);
    const { children } = this.extractChildren(code);

    return {
      type: direction === 'row' ? 'row' : 'column',
      platform,
      properties: props,
      children,
    };
  }

  private parseStack(code: string, platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    const { children } = this.extractChildren(code);
    return {
      type: 'stack',
      platform,
      children,
    };
  }

  private parseCenter(code: string, platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    const { child } = this.extractChild(code);
    return {
      type: 'center',
      platform,
      ...(child ? { child } : {}),
    };
  }

  private parsePadding(code: string, platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    const props = this.extractProperties(code);
    const { child } = this.extractChild(code);
    return {
      type: 'padding',
      platform,
      properties: props,
      ...(child ? { child } : {}),
    };
  }

  private parseSizedBox(code: string, platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    const props = this.extractProperties(code);
    const { child } = this.extractChild(code);
    return {
      type: 'sizedBox',
      platform,
      properties: props,
      ...(child ? { child } : {}),
    };
  }

  private parseButton(code: string, platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    const buttonType = code.startsWith('ElevatedButton') ? 'elevatedButton' :
                       code.startsWith('TextButton') ? 'textButton' : 'outlinedButton';
    const { child } = this.extractChild(code);
    const props = this.extractProperties(code);

    const onPressedMatch = code.match(/onPressed:\s*\{/);
    if (onPressedMatch) {
      props.onPressed = 'true';
    }

    return {
      type: buttonType,
      platform,
      properties: props,
      ...(child ? { child } : {}),
    };
  }

  private parseIcon(code: string): Record<string, unknown> {
    const iconMatch = code.match(/Icons\.(\w+)/);
    const props: Record<string, string> = {};
    if (iconMatch) {
      props.icon = iconMatch[1];
    }
    const sizeMatch = code.match(/size:\s*([\d.]+)/);
    if (sizeMatch) {
      props.size = sizeMatch[1];
    }
    const colorMatch = code.match(/color:\s*Colors\.(\w+)/);
    if (colorMatch) {
      props.color = colorMatch[1];
    }
    return {
      type: 'icon',
      properties: props,
    };
  }

  private parseImage(code: string): Record<string, unknown> {
    const props: Record<string, string> = {};
    const urlMatch = code.match(/['"]([^'"]+)['"]/);
    if (urlMatch) {
      props.src = urlMatch[1];
    }
    const widthMatch = code.match(/width:\s*([\d.]+)/);
    if (widthMatch) {
      props.width = widthMatch[1];
    }
    const heightMatch = code.match(/height:\s*([\d.]+)/);
    if (heightMatch) {
      props.height = heightMatch[1];
    }
    const fitMatch = code.match(/fit:\s*BoxFit\.(\w+)/);
    if (fitMatch) {
      props.fit = fitMatch[1];
    }
    return {
      type: 'image',
      properties: props,
    };
  }

  private parseListView(code: string, platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    const props = this.extractProperties(code);
    const { children } = this.extractChildren(code);
    return {
      type: 'listView',
      platform,
      properties: props,
      children,
    };
  }

  private parseAppBar(code: string, platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    const props = this.extractProperties(code);
    return {
      type: 'appBar',
      platform,
      properties: props,
    };
  }

  private parseFab(code: string, platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    const props = this.extractProperties(code);
    const { child } = this.extractChild(code);
    return {
      type: 'floatingActionButton',
      platform,
      properties: props,
      ...(child ? { child } : {}),
    };
  }

  private parseScaffold(code: string, platform: 'material' | 'fluent' | 'chart'): Record<string, unknown> {
    const props = this.extractProperties(code);

    const appBarMatch = code.match(/appBar:\s*(AppBar\([\s\S]*?\))/);
    const bodyMatch = code.match(/body:\s*(.+)$/);
    const fabMatch = code.match(/floatingActionButton:\s*(.+)$/);

    const children: Record<string, unknown>[] = [];

    if (appBarMatch) {
      const appBarNode = this.parseAppBar(appBarMatch[1], platform);
      children.push(appBarNode);
    }

    let bodyNode: Record<string, unknown> | null = null;
    if (bodyMatch) {
      const bodyCode = this.balanceParens(bodyMatch[1]);
      if (bodyCode) {
        bodyNode = this.parseWidget(bodyCode, platform);
      }
    }

    if (fabMatch) {
      const fabCode = this.balanceParens(fabMatch[1]);
      if (fabCode) {
        const fabNode = this.parseWidget(fabCode, platform);
        children.push(fabNode);
      }
    }

    return {
      type: 'scaffold',
      platform,
      properties: props,
      ...(bodyNode ? { body: bodyNode } : {}),
      children,
    };
  }

  private parseFluentTheme(code: string): Record<string, unknown> {
    const props = this.extractProperties(code);
    const { child } = this.extractChild(code);
    return {
      type: 'fluentTheme',
      platform: 'fluent',
      properties: props,
      ...(child ? { child } : {}),
    };
  }

  private parseCommandBar(code: string): Record<string, unknown> {
    const props = this.extractProperties(code);
    const { children } = this.extractChildren(code);
    return {
      type: 'commandBar',
      platform: 'fluent',
      properties: props,
      children,
    };
  }

  private parseNavigationView(code: string): Record<string, unknown> {
    const props = this.extractProperties(code);
    const paneMatch = code.match(/pane:\s*NavigationPane\(([\s\S]*?)\)/);
    const contentMatch = code.match(/content:\s*(.+)$/);

    if (paneMatch) {
      const itemsMatch = paneMatch[1].match(/items:\s*\[([\s\S]*?)\]/);
      if (itemsMatch) {
        props.paneItems = itemsMatch[1];
      }
    }

    let contentNode: Record<string, unknown> | null = null;
    if (contentMatch) {
      const contentCode = this.balanceParens(contentMatch[1]);
      if (contentCode) {
        contentNode = this.parseWidget(contentCode, 'fluent');
      }
    }

    return {
      type: 'navigationView',
      platform: 'fluent',
      properties: props,
      ...(contentNode ? { content: contentNode } : {}),
    };
  }

  private parseChart(code: string): Record<string, unknown> {
    const chartType = code.startsWith('BarChart') ? 'barChart' :
                      code.startsWith('LineChart') ? 'lineChart' : 'pieChart';

    const props: Record<string, unknown> = {};

    const dataMatch = code.match(/data:\s*\[([\s\S]*?)\]/);
    if (dataMatch) {
      const series: Record<string, unknown>[] = [];
      const dataItems = dataMatch[1].split('),');
      for (const item of dataItems) {
        const xMatch = item.match(/x:\s*([\d.]+)/);
        const yMatch = item.match(/y:\s*([\d.]+)/);
        const labelMatch = item.match(/label:\s*['"]([^'"]+)['"]/);
        const valueMatch = item.match(/value:\s*([\d.]+)/);
        if ((xMatch || labelMatch) && (yMatch || valueMatch)) {
          series.push({
            x: xMatch ? parseFloat(xMatch[1]) : (labelMatch ? labelMatch[1] : ''),
            y: yMatch ? parseFloat(yMatch[1]) : (valueMatch ? parseFloat(valueMatch[1]) : 0),
          });
        }
      }
      if (series.length > 0) {
        props.series = series;
      }
    }

    const animateMatch = code.match(/animate:\s*(true|false)/);
    if (animateMatch) {
      props.animate = animateMatch[1] === 'true';
    }

    return {
      type: chartType,
      platform: 'chart',
      properties: props,
    };
  }

  private balanceParens(code: string): string | null {
    let depth = 0;
    let started = false;
    let result = '';
    let firstParenIndex = -1;

    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === '(' && !started) {
        started = true;
        firstParenIndex = i;
        depth = 1;
        continue;
      }
      if (!started) continue;

      if (ch === '(') depth++;
      if (ch === ')') depth--;

      if (depth === 0) {
        result = code.substring(firstParenIndex + 1, i);
        break;
      }
    }

    return result || null;
  }

  private splitTopLevelCommas(code: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';

    for (const ch of code) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += ch;
      }
    }

    if (current.trim()) {
      parts.push(current);
    }

    return parts;
  }
}
