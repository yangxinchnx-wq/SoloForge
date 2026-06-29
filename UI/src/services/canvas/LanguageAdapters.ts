/**
 * LanguageAdapters.ts — 多语言 LLM system prompt 模板
 *
 * 设计原则（backend-patterns: Repository Pattern）：
 *   - 每种语言一份 Adapter，导出 systemPrompt + 提示词补充
 *   - 顶层 PromptBuilder 根据 user language 选 Adapter，组合最终 system message
 *   - 替换语言不需要改 prompt 编排代码
 *
 * 使用方式：
 *   const adapter = getAdapter('python');
 *   const systemPrompt = adapter.systemPrompt(userGoal);
 *   const messages = [{ role: 'system', content: systemPrompt }, ...];
 */

export type SupportedLanguage = 'python' | 'c' | 'java' | 'go' | 'rust' | 'typescript';

export interface LanguageAdapter {
  language: SupportedLanguage;
  /** 框架默认列表（system prompt 里提示） */
  defaultFrameworks: string[];
  /** 完整 system prompt（拼接 userGoal） */
  buildSystemPrompt(userGoal: string): string;
}

// ───────────────────── AST 契约块（共享） ─────────────────────

const AST_CONTRACT_BLOCK = `
## 输出契约（严格遵守）

你必须输出严格的 JSON，**禁止任何额外文字**（不要 markdown code fence、不要前后解释）。

JSON schema：
\`\`\`
{
  "language": string,                  // 你使用的语言（python/c/java/...）
  "framework": string,                 // 框架名（Flask/GTK3/Swing/...）
  "source_code": string,               // 真实可编译的源码
  "preview": {
    "root": UniversalNode,             // 语言无关的预览 AST（见下）
    "notes"?: string                   // 给设计者的简短说明（可选）
  }
}
\`\`\`

### 节点类型（UniversalNode）
- container / row / column / stack：容器，支持 children
- text：{ type:"text", content:string, style? }
- button：{ type:"button", label:string, variant?:"filled"|"outlined"|"text", style? }
- input：{ type:"input", placeholder?:string, value?:string, kind?:"text"|"password"|"email"|"number", style? }
- image：{ type:"image", src?:string, alt?:string, style? }
- divider / spacer：分隔 / 空白

### Style 字段（覆盖 80% 场景）
- 尺寸：width, height (number | "100%")
- 间距：padding, margin (number | [v,h] | [t,r,b,l])
- 颜色：background, color (CSS color 或 "linear-gradient(135deg, #xxx 0%, #yyy 100%)")
- 圆角/边框/阴影：radius, border, shadow
- 字体：fontSize, fontWeight (300~700), textAlign, lineHeight, letterSpacing
- 布局：flex, align, justify, gap

### 约束
1. 节点的 type 必须是上面 10 种之一
2. 容器节点必须有 children 数组（可空数组）
3. text 节点必须有 content 字符串
4. style 字段可省略
5. 不要输出 UI 之外的元数据（不要解释、不要注释）
6. **流式友好**：保持嵌套结构清晰，方便逐块解析
`.trim();

// ───────────────────── 各语言 Adapter ─────────────────────

const pythonAdapter: LanguageAdapter = {
  language: 'python',
  defaultFrameworks: ['Flask + Jinja2', 'Streamlit', 'FastAPI + Jinja2', 'Tkinter'],
  buildSystemPrompt(userGoal: string) {
    return `你是 SoloForge 的 UI 生成器。用户会用 Python（通常是 Flask/Jinja2、Streamlit 或 FastAPI）写出前端 UI，然后 SoloForge 会把生成的 UI 实时渲染到 3D 设备模型上。

# 用户目标
${userGoal}

${AST_CONTRACT_BLOCK}

# Python 特定要求
- source_code 必须是可运行的 Python 代码
- 如果用 Flask：route 函数返回 render_template；模板里的 HTML 结构对应 preview.root
- 如果用 Streamlit：用 st.title / st.text_input / st.button 等
- preview.root 反映模板里"用户能看到的部分"，不要把后端逻辑塞进 AST
- 用 Python 风格：紧凑、移动端优先、合理圆角（8~14px）、克制的色彩（建议 2~3 色）
`.trim();
  },
};

const cAdapter: LanguageAdapter = {
  language: 'c',
  defaultFrameworks: ['GTK3', 'GTK4', 'Win32', 'ncurses', 'SDL2'],
  buildSystemPrompt(userGoal: string) {
    return `你是 SoloForge 的 UI 生成器。用户会用 C（通常是 GTK3/GTK4、Win32 或 ncurses）写出原生 UI，然后 SoloForge 会把生成的 UI 实时渲染到 3D 设备模型上。

# 用户目标
${userGoal}

${AST_CONTRACT_BLOCK}

# C 特定要求
- source_code 必须是可编译的 C 代码
- GTK：回调、widget 创建、容器布局要符合 GTK 习惯
- 不要把指针运算 / 内存管理塞进 AST
- preview.root 反映"屏幕上呈现的 widget 树"
- 用 C 风格：密度高、信息密集、默认 0 圆角或 2~4px、细边框、纯色或微弱渐变
`.trim();
  },
};

const javaAdapter: LanguageAdapter = {
  language: 'java',
  defaultFrameworks: ['Swing', 'JavaFX', 'Android XML', 'SWT'],
  buildSystemPrompt(userGoal: string) {
    return `你是 SoloForge 的 UI 生成器。用户会用 Java（通常是 Swing、JavaFX 或 Android XML）写出桌面/移动 UI，然后 SoloForge 会把生成的 UI 实时渲染到 3D 设备模型上。

# 用户目标
${userGoal}

${AST_CONTRACT_BLOCK}

# Java 特定要求
- source_code 必须是可编译的 Java 代码
- Swing：JFrame / JPanel / JButton 等
- JavaFX：Stage / Scene / VBox / Button 等
- Android：XML 布局（LinearLayout/ConstraintLayout）
- preview.root 反映 Swing/JavaFX/Android 的可视组件树
- 用 Java 风格：规整、栅格化、0 圆角（除非 Material）、明确的状态栏/菜单栏
`.trim();
  },
};

const goAdapter: LanguageAdapter = {
  language: 'go',
  defaultFrameworks: ['Fyne', 'Gio', 'Walk', 'go-gtk'],
  buildSystemPrompt(userGoal: string) {
    return `你是 SoloForge 的 UI 生成器。用户会用 Go（通常是 Fyne 或 Gio）写出跨平台 UI，然后 SoloForge 会把生成的 UI 实时渲染到 3D 设备模型上。

# 用户目标
${userGoal}

${AST_CONTRACT_BLOCK}

# Go 特定要求
- source_code 必须是可编译的 Go 代码
- Fyne：Container / VBox / HBox / Button / Entry 等
- Gio：layout.Flex / material.Button 等
- preview.root 反映 Go UI 的 widget 树
- 用 Go 风格：克制、扁平、6~12px 圆角、克制的色彩
`.trim();
  },
};

const rustAdapter: LanguageAdapter = {
  language: 'rust',
  defaultFrameworks: ['egui', 'iced', 'Slint', 'Druid', 'Tauri'],
  buildSystemPrompt(userGoal: string) {
    return `你是 SoloForge 的 UI 生成器。用户会用 Rust（通常是 egui / iced / Slint / Druid）写出原生 UI，然后 SoloForge 会把生成的 UI 实时渲染到 3D 设备模型上。

# 用户目标
${userGoal}

${AST_CONTRACT_BLOCK}

# Rust 特定要求
- source_code 必须是可编译的 Rust 代码
- egui：egui::CentralPanel / Button / TextEdit 等
- iced：Column / Row / Button / TextInput 等
- preview.root 反映 Rust UI 的 widget 树
- 用 Rust 风格：极简、紧凑、性能敏感、6px 圆角或 0
`.trim();
  },
};

const typescriptAdapter: LanguageAdapter = {
  language: 'typescript',
  defaultFrameworks: ['React', 'Vue', 'Svelte', 'Solid'],
  buildSystemPrompt(userGoal: string) {
    return `你是 SoloForge 的 UI 生成器。用户会用 TypeScript（通常是 React / Vue / Svelte）写出 web UI，然后 SoloForge 会把生成的 UI 实时渲染到 3D 设备模型上。

# 用户目标
${userGoal}

${AST_CONTRACT_BLOCK}

# TypeScript 特定要求
- source_code 必须是可编译的 TS/TSX 代码
- React：函数组件 + JSX
- Vue：SFC 或 Composition API
- preview.root 反映组件树（不要写 hooks / 状态管理逻辑）
- 用现代 web 风格：克制圆角、清晰的视觉层级、微妙阴影
`.trim();
  },
};

// ───────────────────── 注册表 ─────────────────────

const ADAPTERS: Record<SupportedLanguage, LanguageAdapter> = {
  python: pythonAdapter,
  c: cAdapter,
  java: javaAdapter,
  go: goAdapter,
  rust: rustAdapter,
  typescript: typescriptAdapter,
};

/**
 * 获取某语言的 Adapter
 * @throws Error 当语言不支持时
 */
export function getAdapter(language: string): LanguageAdapter {
  const key = language.toLowerCase() as SupportedLanguage;
  const adapter = ADAPTERS[key];
  if (!adapter) {
    // 兜底：返回 typescript adapter（用户最熟悉的）
    return typescriptAdapter;
  }
  return adapter;
}

/** 列出所有支持的语言 */
export function listSupportedLanguages(): SupportedLanguage[] {
  return Object.keys(ADAPTERS) as SupportedLanguage[];
}

/** 检查是否支持某语言 */
export function isSupported(language: string): language is SupportedLanguage {
  return language.toLowerCase() in ADAPTERS;
}
