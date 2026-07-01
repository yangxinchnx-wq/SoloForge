import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, CheckCircle2, Loader2, Clock, ChevronDown, ChevronUp, Brain, Upload, Hammer, Tag, FolderHeart, Globe, Shield, Cpu, Zap, Check, ShieldCheck, Flame, BadgeCheck, Gauge, Workflow, Rocket, FileText, CheckCheck, Copy, FileCode, X, HelpCircle, Download, SlidersHorizontal, Smile, Volume2, Key, Code, Database, CreditCard, MessageSquare, FolderPlus, Circle, Pencil, Trash2, GripVertical } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import TerminalPanel from './TerminalPanel';

import { AndroidIcon, WindowsIcon, HarmonyOSIcon, DefaultChatIcon } from './HistoryAndEditorPanel';
import { ModelIcon } from './ModelIcon';
import { ToolCallCard } from './ToolCallCard';

export const NormalIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg className={`${className} text-emerald-400 group-hover:text-emerald-300 transition-all duration-300 filter drop-shadow-[0_0_4px_rgba(16,185,129,0.35)]`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {/* Sleek multi-layered security grid shield */}
    <path d="M12 2s-8 3-8 8v4c0 5 8 8 8 8s8-3 8-8v-4c0-5-8-8-8-8z" stroke="currentColor" strokeWidth="1.8" fill="currentColor" fillOpacity="0.08" />
    <path d="M12 5.5s-5 2-5 5v3c0 3.5 5 5.5 5 5.5s5-2 5-5.5v-3c0-3-5-5-5-5z" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" strokeOpacity="0.75" />
    <path d="m9 12 2 2 4-4.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const PerformanceIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg className={`${className} text-purple-400 group-hover:text-purple-300 transition-all duration-300 filter drop-shadow-[0_0_4px_rgba(168,85,247,0.35)]`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {/* Semicircular Dashboard dial Arc */}
    <path d="M4 17.5A8 8 0 1 1 20 17.5" stroke="currentColor" strokeWidth="2" strokeOpacity="0.30" />
    <path d="M6.5 15A5.5 5.5 0 1 1 17.5 15" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.5 2.5" strokeOpacity="0.75" />
    {/* Small speed tick indicators */}
    <path d="M5 16.5l1.2-1.2M19 16.5l-1.2-1.2M12 4v2" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.7" />
    {/* Indicator needle pointing pointing to upper right (High speed) */}
    <path d="M12 12l4.5-4.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    {/* Central hub element */}
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="0.8" strokeOpacity="0.5" />
  </svg>
);

export const ExpertIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg 
    className={`${className} text-amber-500 group-hover:text-amber-400 transition-all duration-300 filter drop-shadow-[0_0_5px_rgba(245,158,11,0.45)]`} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="1.8" 
    strokeLinecap="round" 
    strokeLinejoin="round"
  >
    {/* Academic scholar/expert mortarboard cap */}
    <path d="M12 3.5L2.5 8l9.5 4.5 9.5-4.5-9.5-4.5z" stroke="currentColor" strokeWidth="1.8" fill="currentColor" fillOpacity="0.10" />
    <path d="M6 10.5v3.5c0 1.8 2.7 3.5 6 3.5s6-1.7 6-3.5v-3.5" stroke="currentColor" strokeWidth="1.8" fill="currentColor" fillOpacity="0.05" />
    {/* Hanging credential tassel */}
    <path d="M20.5 8.5v5.5" stroke="currentColor" strokeWidth="1" />
    <circle cx="20.5" cy="14" r="1" fill="currentColor" />
    {/* Central expert credential target point */}
    <circle cx="12" cy="18.5" r="1.5" fill="currentColor" />
    <path d="M12 14v2" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.5 1.5" />
  </svg>
);

export const UltimateIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg 
    className={`${className} text-red-500 group-hover:text-red-400 transition-all duration-300 filter drop-shadow-[0_0_6px_rgba(239,68,68,0.5)]`} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="1.8" 
    strokeLinecap="round" 
    strokeLinejoin="round"
  >
    {/* Circular energy boundary aura */}
    <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.25" strokeDasharray="3 2" />
    {/* High frequency energetic lightning bolt */}
    <path 
       d="M13.5 2L5.5 12h6.5l-2.5 10 9-10h-6.5L13.5 2z" 
       fill="currentColor" 
       fillOpacity="0.2" 
       stroke="currentColor" 
       strokeWidth="2.2" 
       strokeLinejoin="miter" 
    />
  </svg>
);

interface ChatMessage {
  sender: 'user' | 'assistant';
  content: string;
  time: string;
  avatar: string;
  attachment?: {
    fileName: string;
    text: string;
  };
  toolCalls?: import('../types').ToolCall[];
}

function CollapsibleCodeBlock({ fileName, text }: { fileName: string; text: string }) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const lineCount = text.split('\n').length;
  
  return (
    <div className="mt-2 border border-outline bg-surface rounded-lg overflow-hidden w-full max-w-full">
      <div 
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between p-2.5 bg-surface-bright/50 hover:bg-surface transition-colors cursor-pointer select-none"
      >
        <div className="flex items-center gap-2 text-[11px] font-sans font-medium text-on-surface/90 min-w-0">
          <FileCode className="w-4 h-4 text-primary shrink-0" />
          <span className="truncate max-w-[240px] font-bold text-on-surface">{fileName}</span>
          <span className="text-[10px] text-on-surface/40 font-mono shrink-0">({lineCount} 行代码)</span>
        </div>
        <div className="flex items-center gap-1 text-on-surface/50 text-[10px] shrink-0">
          <span>{isExpanded ? '点击收起' : '点击展开代码'}</span>
          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </div>
      </div>
      
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden border-t border-outline/30"
          >
            <div className="relative">
              <pre className="max-h-72 overflow-auto p-3 font-mono text-[10.5px] text-on-surface/85 bg-bg/40 select-text scrollbar-thin scrollbar-thumb-outline/50 scrollbar-track-transparent leading-relaxed whitespace-pre font-bold">
                <code>{text}</code>
              </pre>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(text);
                  const customToastEv = new CustomEvent('soloforge-toast', {
                    detail: { message: '代码已复制至剪贴板', type: 'success' }
                  });
                  window.dispatchEvent(customToastEv);
                }}
                className="absolute top-2.5 right-2.5 p-1.5 rounded bg-surface-bright border border-outline/40 text-on-surface hover:text-primary transition-all cursor-pointer shadow"
                title="复制全部代码"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FormatChatMessage({ content }: { content: string }) {
  if (!content) return null;

  // Split by ``` to extract code blocks
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-3.5 select-text w-full max-w-full overflow-hidden">
      {parts.map((part, index) => {
        if (part.startsWith('```')) {
          // It is a code block! Get language and code
          const match = part.match(/```([a-zA-Z0-9+#-]*)\n([\s\S]*?)```/);
          const lang = match ? match[1] : '';
          const code = match ? match[2] : part.slice(3, -3);

          return (
            <div key={index}>
              <CollapsibleCodeBlock 
                fileName={lang ? `智脑生成文件 (.${lang})` : '智脑配置代码段'} 
                text={code.trim()} 
              />
            </div>
          );
        } else {
          // Standard text! Let's format paragraphs and inline elements
          const paragraphs = part.split('\n\n');
          return paragraphs.map((para, pIdx) => {
            if (!para.trim()) return null;

            // Render bold / inline code / bullet lists
            const lines = para.split('\n');
            return (
              <div key={`${index}-${pIdx}`} className="space-y-1 py-0.5">
                {lines.map((line, lIdx) => {
                  let renderedLine = line.trim();
                  if (!renderedLine) return <div key={lIdx} className="h-1.5" />;
                  
                  // If it's a list item
                  const isBullet = renderedLine.startsWith('- ') || renderedLine.startsWith('* ');
                  const isNumbered = /^\d+\.\s/.test(renderedLine);
                  
                  if (isBullet) {
                    renderedLine = renderedLine.substring(2);
                  } else if (isNumbered) {
                    const matchNum = renderedLine.match(/^(\d+\.\s)(.*)/);
                    if (matchNum) {
                      renderedLine = matchNum[2];
                    }
                  }

                  // Process bold **text** -> strong
                  const boldParts = renderedLine.split(/(\*\*.*?\*\*)/g);
                  const processedInline = boldParts.map((bp, bIdx) => {
                    if (bp.startsWith('**') && bp.endsWith('**')) {
                      return <strong key={bIdx} className="text-primary font-black">{bp.slice(2, -2)}</strong>;
                    }
                    
                    // Process inline code `code`
                    const codeParts = bp.split(/(`.*?`)/g);
                    return codeParts.map((cp, cIdx) => {
                      if (cp.startsWith('`') && cp.endsWith('`')) {
                        return (
                          <code key={cIdx} className="px-1.5 py-0.5 rounded bg-black/60 border border-white/5 font-mono text-[11px] text-emerald-400 font-bold mx-0.5">
                            {cp.slice(1, -1)}
                          </code>
                        );
                      }
                      return cp;
                    });
                  });

                  if (isBullet) {
                    return (
                      <div key={lIdx} className="flex gap-2 pl-2 text-on-surface/90 text-[12px] leading-relaxed select-text mt-1">
                        <span className="text-primary font-bold shrink-0 select-none">•</span>
                        <span>{processedInline}</span>
                      </div>
                    );
                  }

                  if (isNumbered) {
                    const numString = line.trim().match(/^(\d+)/)?.[1] || '';
                    return (
                      <div key={lIdx} className="flex gap-2 pl-2 text-on-surface/90 text-[12px] leading-relaxed select-text mt-1">
                        <span className="text-primary font-bold shrink-0 font-mono text-[11px] select-none">{numString}.</span>
                        <span>{processedInline}</span>
                      </div>
                    );
                  }

                  return (
                    <p key={lIdx} className="text-on-surface/90 text-[12px] leading-relaxed select-text">
                      {processedInline}
                    </p>
                  );
                })}
              </div>
            );
          });
        }
      })}
    </div>
  );
}

interface ChatPanelProps {
  permissionMode?: 'normal' | 'performance' | 'ultimate' | 'expert';
  setPermissionMode?: (mode: 'normal' | 'performance' | 'ultimate' | 'expert') => void;
  primaryColorTargets?: {
    activityBar: boolean;
    skillBar: boolean;
    header: boolean;
    chatPanel: boolean;
    editorAndExplorer: boolean;
  };
  selectedChatId?: string;
  mainModel?: string;
  secModels?: any[];
  mixedTasks?: boolean;
  selectedFile?: string;
  editorContent?: string;
  modelProviderMap?: Record<string, {
    baseUrl: string;
    apiKey: string;
    model: string;
    providerName: string;
    enabledInSettings: boolean;
  }>;
}

export interface ChatSettingsItem {
  enabledSkills: string[];
  contextSize: number;
  personality: 'professional' | 'sarcastic' | 'zen' | 'geek';
  tone: 'detailed' | 'concise' | 'humorous';
  emojiEnabled: boolean;
  emojiType: 'standard' | 'kaomoji' | 'mixed';
}

const defaultChatDetails: Record<string, { title: string; icon: any }> = {
  '1': { title: '电商平台原型开发', icon: Code },
  '2': { title: '用户认证 system 设计', icon: Key },
  '3': { title: 'API 接口文档生成', icon: Brain },
  '4': { title: '数据库表结构设计', icon: Database },
  '5': { title: '支付模块集成方案', icon: CreditCard },
  '6': { title: '优化建议', icon: HelpCircle },
};

const defaultConversations: Record<string, ChatMessage[]> = {
  '1': [
    { sender: 'user', content: '帮我创建一个博客系统，包含文章列表、文章详情、评论功能，使用Vue3 + Node.js', time: '11:59:58', avatar: '' }
  ],
  '2': [
    { sender: 'user', content: '我们需要设计一套鲁棒的基于 JWT 和 HttpOnly Cookies 的双令牌认证系统，包含 Refresh Token 手段。', time: '09:12:00', avatar: '' },
    { sender: 'assistant', content: '已经为您储备好了安全双令牌机制。RefreshToken 保存于严格的 HttpOnly 专属 Cookie，AccessToken 在内存中临时维持 (过载失效15分钟)，完美匹配安全合规守则。', time: '09:13:00', avatar: '' }
  ],
  '3': [
    { sender: 'user', content: '能帮我针对核心逻辑生成一份 API 文档并一键注释吗？', time: '16:04:22', avatar: '' }
  ],
  '4': [
    { sender: 'user', content: '设计一个支持项目分类、多对多标签数据库表关联。', time: '昨天', avatar: '' }
  ],
  '5': [
    { sender: 'user', content: '看一下中国主流 H5 调起以及三方支付模块对接思路。', time: '前天', avatar: '' }
  ],
  '6': [
    { sender: 'user', content: '有哪些前端极端性能优化、极致首屏指标项需要注意？', time: '三天前', avatar: '' }
  ]
};

function generateSmartReply(inputText: string, settings: ChatSettingsItem): string {
  const emojiStr = settings.emojiEnabled 
    ? (settings.emojiType === 'kaomoji' 
        ? ' (๑•̀ㅂ•́)و✧ ' 
        : (settings.emojiType === 'standard' ? ' 🚀🤖 ' : ' (✿◠‿◠) 🎉💻 ')) 
    : '';

  let content = '';

  // Personality base response
  if (settings.personality === 'sarcastic') {
    content += `啧，我就知道你会问『${inputText}』这种让人哭笑不得的基础问题。${emojiStr}算了，看在本首席智能架构师的超级心智上，勉为其难、慈悲为怀地赏你两句指点。如果你能稍微写点带脑子的干净代码，我也就不用每天在报错堆栈里做噩梦了！ `;
    
    if (settings.tone === 'concise') {
      content += `听好了，只讲重点：核心就是保持模块解耦，防范死锁和脏写。给你写好的最精简代码，抄好了别再写出Bug了，看下面：\n\n\`\`\`tsx\n// 极简解耦方案\nexport function resolveOptimizedAction<T>(input: T): { success: boolean, payload: T } {\n  if (!input) throw new Error("输入不能是空的，懂吗？");\n  return { success: true, payload: input };\n}\n\`\`\``;
    } else if (settings.tone === 'humorous') {
      content += `写代码就像谈恋爱，你觉得它优雅简练度拉满，其实只要运行起来它脾气比谁都暴躁。针对这个问题，你大概是像在浴缸里拿捞鱼网捉大白鲨一样在瞎忙活。教你一个能骗过编译器的魔术写法吧：\n\n\`\`\`tsx\n// 幽默版黑科技\nexport function autoMagicCompiling<T>(code: T): T {\n  const bugProbability = Math.random();\n  if (bugProbability > 0.95) {\n    console.warn("发现幽默的未定义行为！不过无伤大雅");\n  }\n  return code; // 保持神秘，不要动它！\n}\n\`\`\``;
    } else {
      content += `好吧，让我们全面地肢解你这堆混乱而野性的代码定义！为了防备由于该底层链路故障导致崩溃，你应该迅速搭造核心防线。
以下是极其严苛的分析与企业级代码实现：
1. **彻底校验入参**：任何未定义的对象不仅是Bug之母，更是内存泄栈的元凶。
2. **构建哈希防卫链路**：严格遵循 lines 变动追踪，确保任何操作有迹可循。
3. **隔离级高并发**：隔离敏感进程，任何死锁报错不波及外层全局生命周期。

\`\`\`tsx\n// 安全稳健的企业级包装器\nexport class EnterpriseSecureProcessor<T> {\n  private stateTrace = new Map<string, T>();\n  \n  public processBatch(id: string, data: T | null): T {\n    if (data === null || data === undefined) {\n      throw new Error("[安全警报] 拒绝处理无效空对象。别想挑战系统漏洞！");\n    }\n    this.stateTrace.set(id, data);\n    console.log(\`[哈希防卫圈] 记录变动帧成功：\${id}\`);\n    return data;\n  }\n}\n\`\`\``;
    }
  } else if (settings.personality === 'zen') {
    content += `善哉。施主问到『${inputText}』，在代码的喧嚣世界里，这正是一次叩问技术边界的绝佳契机。${emojiStr}世间万物，去繁就简、返璞归真。编程正如修行，每一行缩进，都是心境的修行投影；每一次报错，皆是让内心归零的心性磨砺…… `;

    if (settings.tone === 'concise') {
      content += `只言片语，贵在顿悟。去浮奢、存本真，最质朴的修身写法：\n\n\`\`\`tsx\n// 禅意极简写法\nexport const findInnerPeace = <T>(zenNode: T): T => {\n  return zenNode; // 一法不立，万法皆备。顺其自然，即是最佳运行状态\n};\n\`\`\``;
    } else if (settings.tone === 'humorous') {
      content += `佛法讲求机锋，代码也有它的前世因果。施主写下的那行深不可测的递归，或许正是上辈子没解开的因果红尘。这里有一段略带幽默的度化代码，保佑施主早日修得正果，避开黄牌警告：\n\n\`\`\`tsx\n// 度化报错写法\nexport function purifyStackFrame(errorMessage: string): string {\n  const peaceMind = "（合十）施主，红尘多磨难，报错皆虚妄。";\n  return \`\${peaceMind} 系统已为您洗涤尘埃：\${errorMessage.slice(0, 15)}...\`;\n}\n\`\`\``;
    } else {
      content += `施主请静思。在这个关于『${inputText}』的修行中，我们应当洞察其背后的起信、参悟与圆满：
1. **起信（声明）**：以诚敬之心让全部 state 归宿在干净的空始态中。
2. **行深（流程）**：顺应数据流的轻盈自然流淌，避免任何强力强制重绘。
3. **大圆满（卸载）**：当组件功德圆满、即将离去时，彻底清洗它的 effect 和生命周期，不遗存半点内存垃圾。

\`\`\`tsx\n// 禅意生命周期组件守恒示例\nimport { useEffect } from 'react';\n\nexport function useZenStatePurifier<T>(stateValue: T): T {\n  useEffect(() => {\n    // 净化红尘纷扰，万物归宿\n    return () => {\n      console.log("（合十）无挂碍，大圆满。内存已完美归还浩瀚宇宙。");\n    };\n  }, []);\n  return stateValue;\n}\n\`\`\``;
    }
  } else if (settings.personality === 'geek') {
    content += `噢噢噢噢！！！老铁！这简直让我热血沸腾啊！！！针对你提出的『${inputText}』，这不正好触碰到了我写代码的终极极客之魂了吗！！！！${emojiStr}看我一秒钟切入极致发烧狂热模式，直接调动全部 CPU/GPU 算力爆发，在 0.1 纳秒内狂飙运行，咆哮吧！让代码以极限光速燃烧！！！！！ `;

    if (settings.tone === 'concise') {
      content += `极客眼里没有废话，直接亮剑！看我的狂野高效压榨位运算，速度吊打常规编译器：\n\n\`\`\`tsx\n// 极致超频运算\nexport const turboCompute = (x: number): number => (x * 31) >>> 0; // 用最快的基础位运算，榨干最后1%的延迟！\n\`\`\``;
    } else if (settings.tone === 'humorous') {
      content += `你知道吗老铁，世界上只有两种程序员：一种在研究怎么超频显卡跑万亿参数大模型，另一种在默默发呆决定今天午饭吃麻辣烫还是黄焖鸡。看我写这段超级中二超能粒子电磁炮，直接给代码升维：\n\n\`\`\`tsx\n// 粒子黑盒狂暴流\nexport function activateRailgunEngine(): string {\n  const currentCharge = 1000000;\n  return \`⚡️ 超极电磁炮已锁定！充能进阶中...\${currentCharge}TW！编译时速爆发提升 9999%！⚡\`;\n}\n\`\`\``;
    } else {
      content += `狂飙冲锋！今天我们不眠不休，誓要把所有的无用、冗繁废弃逻辑彻底送上断路器！
针对这套极致压榨的方案，我们要完美触发以下“超频三部曲”：
1. **极限并发事件锁**：使用超高吞吐的微任务 Promise 泵，把所有异步碎片零延迟同步！
2. **行哈希微雕指针**：与 Hashline 强制咬合，行级改动，绝不重刷多余页面！
3. **极限对象池重写**：手动拦截 GC (垃圾回收)，完全不给 JavaScript 回收引擎造成任何震动！

\`\`\`tsx\n// 极其硬核的极客大对象缓冲池\nexport class HeavyLoaderHyperEngine<Payload> {\n  private ringBuffer: Array<Payload> = new Array(2048);\n  private head = 0;\n  \n  public push(task: Payload): void {\n    this.ringBuffer[this.head] = task;\n    this.head = (this.head + 1) % 2048;\n    console.log("🚀 [超频缓冲控制] 性能爆燃！10纳秒极密泵注入环形对象池。");\n  }\n}\n\`\`\``;
    }
  } else {
    // Professional (默认专业)
    content += `收到您的工程指令。针对关于『${inputText}』的设计提案，我们将从架构可靠度、安全守卫和面向未来的高内聚解耦维度提供精细化构建。${emojiStr}在设计健壮的企业级微前端或复杂组件逻辑时，周详的泛型验证、异常安全屏障与防御式设计方案，是交付高标准代码的必要支柱…… `;

    if (settings.tone === 'concise') {
      content += `我们已经为您拟定了如下精干、精打细算、类型完备的标准工业解决方案：\n\n\`\`\`tsx\n// 标准工业应用级契约\nexport interface ServiceResult<T> {\n  success: boolean;\n  data: T;\n  timestamp: number;\n}\n\nexport function resolvePayload<T>(payload: T): ServiceResult<T> {\n  return { success: true, data: payload, timestamp: Date.now() };\n}\n\`\`\``;
    } else if (settings.tone === 'humorous') {
      content += `从敏捷工程管理的专业角度出发，我们在写单元测试时应当多添加几层无伤大雅的延迟模拟。因为这更容易在产品经理走过你工位时展现出你在高难度处理海量负载。为此我们提供以下带有人道主义摸鱼保障的优秀设计：\n\n\`\`\`tsx\n// 摸鱼保障型中间件\nexport function highLoadSimulator<T>(task: T): T {\n  const stressLevel = Math.floor(Math.random() * 800);\n  console.log(\`💻 [编译流水线] 伪装出高强度的算法分析，实际已摸鱼耗时 \${stressLevel}ms...\`);\n  return task;\n}\n\`\`\``;
    } else {
      content += `我们针对您的架构需要，梳理了以下安全防御的核心交付标准：
1. **强类型防守圈**：严格排除 \`any\` 侵入，所有入参流均附加泛型深度约束及守护器。
2. **异步平滑防抖机制**：对于密集爆发的数据流进行去重 and 缓存防爆破限制。
3. **安全会话持久化**：使用 localStorage 快照并加入防溢出隔离，随时随地优雅热恢复。

\`\`\`tsx\n// 标准工业防守型数据处理器\nexport class DurableSessionManager<DataModel> {\n  private storageKey = "soloforge_session_cache";\n\n  public saveState(id: string, payload: DataModel): void {\n    try {\n      const rawData = localStorage.getItem(this.storageKey) || "{}";\n      const parsed = JSON.parse(rawData);\n      parsed[id] = payload;\n      localStorage.setItem(this.storageKey, JSON.stringify(parsed));\n      console.log(\`[持久化] 已成功将ID \${id} 的数据序列化安全存盘。\`);\n    } catch (e) {\n      console.error("[系统异常] 发生外部写入干扰: ", e);\n    }\n  }\n}\n\`\`\``;
    }
  }

  // Active skills indication
  if (settings.enabledSkills.length > 0) {
    const skillEmojiMap: Record<string, string> = {
      'custom_rules': '📋 自定义约束.md 规划',
      'frontend_expert': '🎨 前端专家',
      'db_manager': '💾 数据库主管',
      'security_warden': '🛡️ 安全保卫官',
      'hashline_auditor': '⚙️ 哈希行级编辑器校验',
    };
    const activeSkillsList = settings.enabledSkills.map(sk => skillEmojiMap[sk] || sk).join(', ');
    content += `\n\n> [本轮会话已装载并调用专属 Skills 模组：${activeSkillsList}]`;
    if (settings.enabledSkills.includes('custom_rules')) {
      content += `\n> [提示：已读取根目录 custom_rules.md 文档，AI 每次行事将对其中的 To-do 与 Constraints（任务及约束）进行自动规约与审查]`;
    }
  }

  return content;
}

function getSettingsSummary(s: ChatSettingsItem): string {
  const pMap = { professional: '专业', sarcastic: '毒舌', zen: '禅意', geek: '极客' };
  const tMap = { detailed: '详尽', concise: '简短', humorous: '幽默' };
  const em = s.emojiEnabled ? '表情开' : '表情关';
  const ctxStr = s.contextSize >= 132000 ? '无限制' : `${s.contextSize / 1000}k`;
  return `${pMap[s.personality]} | ${tMap[s.tone]} | ${ctxStr} 窗口 | ${em} (${s.enabledSkills.length} SK)`;
}

// ============================================================
// AI 社会 6 个流式子组件（设计文档：UI/连接.md §4.3）
// 全部只依赖 streamState 切片，无副作用
// ============================================================

// 1. WorkerOutputs - 并行副模型输出卡片
function WorkerOutputsView({ outputs }: { outputs: Array<{ workerIdx: number; modelName: string; content: string; status: string }> }) {
  if (outputs.length === 0) return null;
  return (
    <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/30">
      <div className="px-2.5 py-1.5 bg-surface border-b border-outline/20 flex items-center gap-2 text-[10.5px] text-on-surface/80 font-bold">
        <Workflow className="w-3 h-3" /> 副模型并行输出（{outputs.length}）
      </div>
      <div className="grid grid-cols-1 gap-1.5 p-2">
        {outputs.map(w => (
          <div key={w.workerIdx} className="bg-surface/40 border border-outline/20 rounded-md p-2 text-[11px]">
            <div className="flex items-center justify-between mb-1">
              <span className="font-bold text-on-surface/90">#{w.workerIdx} {w.modelName}</span>
              <span className={
                w.status === 'done' ? 'text-emerald-400' :
                w.status === 'error' ? 'text-rose-400' :
                w.status === 'streaming' ? 'text-amber-400 animate-pulse' :
                'text-on-surface/40'
              }>
                {w.status === 'done' ? '✓ 完成' :
                 w.status === 'error' ? '✗ 失败' :
                 w.status === 'streaming' ? '... 生成中' :
                 '○ 等待'}
              </span>
            </div>
            {w.content && (
              <div className="text-on-surface/70 max-h-24 overflow-y-auto whitespace-pre-wrap text-[10.5px] leading-snug">
                {w.content.length > 300 ? w.content.slice(0, 300) + '...' : w.content}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// 2. ScoresView - Scorer 打分表
function ScoresView({ scores }: { scores: Array<{ workerIdx: number; score: number; reason: string; modelName?: string }> }) {
  if (scores.length === 0) return null;
  return (
    <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/30">
      <div className="px-2.5 py-1.5 bg-surface border-b border-outline/20 flex items-center gap-2 text-[10.5px] text-on-surface/80 font-bold">
        <Gauge className="w-3 h-3" /> Scorer 打分
      </div>
      <div className="p-2 space-y-1 text-[11px]">
        {scores.map(s => (
          <div key={s.workerIdx} className="flex items-start gap-2">
            <span className="font-mono text-on-surface/60 shrink-0">#{s.workerIdx}</span>
            <span className={
              s.score >= 80 ? 'text-emerald-400 font-bold' :
              s.score >= 60 ? 'text-amber-400 font-bold' :
              'text-rose-400 font-bold'
            }>{s.score}分</span>
            <span className="text-on-surface/70 flex-1">{s.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 3. JudgeView - 选定结果
function JudgeView({ chosen, reasoning }: { chosen: number[]; reasoning: string }) {
  if (chosen.length === 0) return null;
  return (
    <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/30">
      <div className="px-2.5 py-1.5 bg-surface border-b border-outline/20 flex items-center gap-2 text-[10.5px] text-on-surface/80 font-bold">
        <BadgeCheck className="w-3 h-3" /> Judge 选定
      </div>
      <div className="p-2 text-[11px] text-on-surface/80">
        <div className="mb-1">选中：<span className="font-mono text-emerald-400">[{chosen.join(', ')}]</span></div>
        {reasoning && <div className="text-on-surface/60 italic">理由：{reasoning}</div>}
      </div>
    </div>
  );
}

// 4. AuditView - 审计发现
function AuditView({ findings }: { findings: Array<{ severity: string; target: string; suggestion: string }> }) {
  if (findings.length === 0) return null;
  const sevColor = (s: string) =>
    s === 'critical' ? 'text-rose-400 border-rose-400/30' :
    s === 'high' ? 'text-orange-400 border-orange-400/30' :
    s === 'medium' ? 'text-amber-400 border-amber-400/30' :
    'text-blue-400 border-blue-400/30';
  return (
    <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/30">
      <div className="px-2.5 py-1.5 bg-surface border-b border-outline/20 flex items-center gap-2 text-[10.5px] text-on-surface/80 font-bold">
        <ShieldCheck className="w-3 h-3" /> Auditor 审计（{findings.length} 项）
      </div>
      <div className="p-2 space-y-1.5 text-[11px]">
        {findings.map((f, i) => (
          <div key={i} className={`border-l-2 pl-2 ${sevColor(f.severity)}`}>
            <div className="flex items-center gap-1.5 font-bold">
              <span className="font-mono">[{f.severity.toUpperCase()}]</span>
              <span>{f.target}</span>
            </div>
            <div className="text-on-surface/70">建议：{f.suggestion}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 5. FinalReplyView - 最终回答（流式）
function FinalReplyView({ content, label }: { content: string; label: string }) {
  if (!content) return null;
  return (
    <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/30">
      <div className="px-2.5 py-1.5 bg-surface border-b border-outline/20 flex items-center gap-2 text-[10.5px] text-on-surface/80 font-bold">
        <Rocket className="w-3 h-3" /> {label}
      </div>
      <div className="p-2.5 text-[11.5px] text-on-surface/90 leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto scrollbar-thin">
        {content}
        <span className="inline-block w-1.5 h-3 bg-primary ml-0.5 animate-pulse" />
      </div>
    </div>
  );
}

// 6. SuggestEnableView - 阶段 0 启发式建议
function SuggestEnableView({ items, onAccept }: { items: Array<{ candidateName: string; expectedGain: number; reason: string }>; onAccept?: (name: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="border border-amber-400/30 rounded-lg overflow-hidden bg-amber-400/5">
      <div className="px-2.5 py-1.5 bg-amber-400/10 border-b border-amber-400/20 flex items-center gap-2 text-[10.5px] text-amber-300 font-bold">
        <Zap className="w-3 h-3" /> 💡 建议启用副模型
      </div>
      <div className="p-2 space-y-1.5 text-[11px]">
        {items.map((s, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="flex-1">
              <div className="text-on-surface/90 font-bold">{s.candidateName}（预期增益 {(s.expectedGain * 100).toFixed(0)}%）</div>
              <div className="text-on-surface/60">{s.reason}</div>
            </div>
            {onAccept && (
              <button
                onClick={() => onAccept(s.candidateName)}
                className="px-2 py-0.5 text-[10px] bg-amber-400/20 hover:bg-amber-400/30 text-amber-300 rounded border border-amber-400/30"
              >
                启用并重发
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ChatPanel({
  permissionMode = 'normal', 
  setPermissionMode,
  primaryColorTargets,
  selectedChatId = '1',
  mainModel = 'GPT-4o',
  secModels = [],
  mixedTasks = false,
  selectedFile = 'BlogSystem/src/App.vue',
  editorContent = '',
  modelProviderMap = {}
}: ChatPanelProps) {
  // Load and cache all conversations keyed by chat ID
  // ==========================================
  // 【后端对接提示 - 获取特定会话下的历史消息记录】
  // 原先直接通过 localStorage 读取了所有对话列表记录。接入后端数据库后：
  // 1. 可以封装接口: GET /api/chats/:chatId/messages，返回该会话的所有消息实体，格式包含: sender, content, attachment, time
  // 2. 将数据保存至对应数据库（如 PostgreSQL / Firestore）的消息历史表中
  // ==========================================
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('soloforge_conversations');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) {
          console.error(e);
        }
      }
    }
    return defaultConversations;
  });

  // Load and cache all configurations keyed by chat ID
  // ==========================================
  // 【后端对接提示 - 获取/更新智能助手的定制化微调参数】
  // 此处保存了每个 AI 对话的具体设置（例如启用的技能知识库、最大上下文限制、AI性格与语气等）：
  // 后期推荐存储到数据库会话配置表中，每次编辑完参数（如在 SettingsModal 调整后）：
  // 接口调用: PUT /api/chats/:chatId/settings, 载荷: configs[chatId]
  // ==========================================
  const [configs, setConfigs] = useState<Record<string, ChatSettingsItem>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('soloforge_chat_configs');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) {
          console.error(e);
        }
      }
    }
    return {
      '1': { enabledSkills: ['custom_rules', 'frontend_expert'], contextSize: 32000, personality: 'professional', tone: 'detailed', emojiEnabled: true, emojiType: 'mixed' },
      '2': { enabledSkills: ['security_warden', 'db_manager'], contextSize: 16000, personality: 'geek', tone: 'concise', emojiEnabled: false, emojiType: 'kaomoji' },
      '3': { enabledSkills: ['custom_rules', 'hashline_auditor'], contextSize: 64000, personality: 'professional', tone: 'detailed', emojiEnabled: true, emojiType: 'standard' },
      '4': { enabledSkills: ['db_manager'], contextSize: 32000, personality: 'zen', tone: 'detailed', emojiEnabled: true, emojiType: 'kaomoji' },
      '5': { enabledSkills: ['frontend_expert', 'security_warden'], contextSize: 32000, personality: 'professional', tone: 'concise', emojiEnabled: false, emojiType: 'mixed' },
      '6': { enabledSkills: ['custom_rules'], contextSize: 132000, personality: 'sarcastic', tone: 'humorous', emojiEnabled: true, emojiType: 'mixed' },
    };
  });

  const [showSettingsPopup, setShowSettingsPopup] = useState(false);
  const [chatsList, setChatsList] = useState<any[]>([]);
  const [pendingAttachment, setPendingAttachment] = useState<{ fileName: string; text: string } | null>(null);
  const [isPendingAttachmentExpanded, setIsPendingAttachmentExpanded] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  // 最近一次发往 /api/ai/chat 的 body - 供「建议启用并重发」使用
  const [lastReqBody, setLastReqBody] = useState<any>(null);

  // ==========================================
  // AI 社会流式状态（设计文档：UI/连接.md §4.2）
  // 单一 assistant 消息包含多个动态区域：reply / score / judge / audit / deliver
  // ==========================================
  const [hashlineAgentEnabled, setHashlineAgentEnabled] = useState(false);

  const [streamState, setStreamState] = useState<{
    workerOutputs: Array<{ workerIdx: number; modelName: string; content: string; status: 'pending' | 'streaming' | 'done' | 'error' }>;
    reply: string;
    scores: Array<{ workerIdx: number; score: number; reason: string; modelName?: string }>;
    judgeChosen: number[];
    judgeReasoning: string;
    auditFindings: Array<{ severity: string; target: string; suggestion: string }>;
    deliver: string;
    suggestEnables: Array<{ candidateName: string; expectedGain: number; reason: string }>;
    toolCalls: Array<import('../types').ToolCall>;
  }>({
    workerOutputs: [],
    reply: '',
    scores: [],
    judgeChosen: [],
    judgeReasoning: '',
    auditFindings: [],
    deliver: '',
    suggestEnables: [],
    toolCalls: [],
  });

  // Update lists and cache to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('soloforge_conversations', JSON.stringify(conversations));
    }
  }, [conversations]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('soloforge_chat_configs', JSON.stringify(configs));
    }
  }, [configs]);

  // Load local chats list on mount and whenever custom event fires
  const loadChatsList = () => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('soloforge_chats_list');
      if (saved) {
        try {
          setChatsList(JSON.parse(saved));
        } catch (e) {
          console.error(e);
        }
      }
    }
  };

  const loadChatConfigs = () => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('soloforge_chat_configs');
      if (saved) {
        try {
          setConfigs(JSON.parse(saved));
        } catch (e) {}
      }
    }
  };

  useEffect(() => {
    loadChatsList();
    window.addEventListener('soloforge-chats-updated', loadChatsList);
    window.addEventListener('soloforge-chat-configs-updated', loadChatConfigs);
    return () => {
      window.removeEventListener('soloforge-chats-updated', loadChatsList);
      window.removeEventListener('soloforge-chat-configs-updated', loadChatConfigs);
    };
  }, []);

  // Fetch settings or default fallback for the active session
  const activeChatId = selectedChatId || '1';
  const activeSettings = configs[activeChatId] || {
    enabledSkills: ['code_review'],
    contextSize: 32000,
    personality: 'professional',
    tone: 'detailed',
    emojiEnabled: true,
    emojiType: 'mixed'
  };

  const handleUpdateActiveSettings = (updates: Partial<ChatSettingsItem>) => {
    setConfigs(prev => ({
      ...prev,
      [activeChatId]: {
        ...activeSettings,
        ...updates
      }
    }));
  };

  // Determine actual active chat details
  const localChatInfo = chatsList.find(c => c.id === activeChatId);
  
  // Predict potential new conversation name to eliminate state transition flickers
  const isTemporaryNewChat = !localChatInfo && 
    !defaultChatDetails[activeChatId] && 
    !isNaN(Number(activeChatId)) && 
    Number(activeChatId) > 1710000000000;

  const activeChatTitle = localChatInfo?.title 
    || defaultChatDetails[activeChatId]?.title 
    || (isTemporaryNewChat ? `新智能对话 #${chatsList.length + 1}` : `智能对话 #${activeChatId}`);
    
  // Resolve active chat icon dynamically
  const getActiveChatIcon = () => {
    if (localChatInfo?.tag === 'ANDROID') return AndroidIcon;
    if (localChatInfo?.tag === 'WINDOWS') return WindowsIcon;
    if (localChatInfo?.tag === 'HARMONY') return HarmonyOSIcon;
    if (localChatInfo?.tag === 'NEW') return DefaultChatIcon;
    
    // Check fallback tags
    if (localChatInfo?.tag === 'VUE') return Code;
    if (localChatInfo?.tag === 'AUTH') return Key;
    if (localChatInfo?.tag === 'AI') return Brain;
    if (localChatInfo?.tag === 'DB') return Database;
    if (localChatInfo?.tag === 'PAY') return CreditCard;
    if (localChatInfo?.tag === 'HELP') return HelpCircle;
    
    return defaultChatDetails[activeChatId]?.icon || DefaultChatIcon;
  };
  const activeChatIcon = getActiveChatIcon();

  // Retrieve active messages array
  const getFallbackMessages = (): ChatMessage[] => {
    if (localChatInfo?.tag === 'ANDROID') {
      return [
        { 
          sender: 'assistant', 
          content: '👋 你好！已为您开启 **Android 应用开发** 专属智能架构与调试辅助面板。\n\n后端系统与真实工具编译调试接口已接入就绪。您可以就以下领域发起提问：\n\n1. 📱 **Jetpack Compose 视图流**：高效的声明式 UI 最佳组件化划分姿态。\n2. 协程 & Flow 异步并发管理，避免主线程卡死现象。\n3. Gradle 构建重构、三方 SDK 统一依赖配置与 Android SDK 高版本适配规约。\n4. 真机/模拟器 ADB 调试报错堆栈智能定位。\n\n请在输入框键入您想要探讨的代码问题！', 
          time: '刚才', 
          avatar: '' 
        }
      ];
    }
    if (localChatInfo?.tag === 'WINDOWS') {
      return [
        { 
          sender: 'assistant', 
          content: '👋 你好！已为您开启 **Windows 软件开发/桌面系统** 专属智能架构辅助面板。\n\n后端编译及运行接口环境整备完成。支持提问的技术体系：\n\n1. 🖥️ **WPF / WinForms / WinUI 3**：MVVM 架构重构及自定义精美现代皮肤制作。\n2. Win32 底层 API 调用、高性能 C++ DLL 混合调用与多线程资源释放预防内存积压。\n3. MSIX / Advanced Installer 标准静默打包、Windows 平台软件防病毒篡改签名工作流。\n4. 针对不同版本的 Windows OS 精细化桌面通知及注册表检索。\n\n欢迎直接向我提供您的需求！', 
          time: '刚才', 
          avatar: '' 
        }
      ];
    }
    if (localChatInfo?.tag === 'HARMONY') {
      return [
        { 
          sender: 'assistant', 
          content: '👋 你好！已为您开启 **鸿蒙 (HarmonyOS / OpenHarmony)** 生态开发专属高级顾问。\n\n后端调试器与 DevEco Studio 热重载模块交互链路随时待命。核心探讨板块示范：\n\n1. 🔴 **ArkTS 极速业务逻辑编写**：理解 `@State`, `@Prop`, `@Link`, `@Provide` 极佳响应式流状态装饰器搭配运作。\n2. ArkUI 自定义精致声明式组件构建，精细控制渲染性能指标。\n3. Stage 分层架构模型规范、多个 Feature Ability (FA级) 交互安全防护与切片加载处理机制。\n4. 鸿蒙原生多设备适配分布式流转，在平板、折叠屏及智能穿戴间无缝同步。\n\n有什么问题尽管问！', 
          time: '刚才', 
          avatar: '' 
        }
      ];
    }
    return [
      { sender: 'user', content: '创建全新对话！请给予我一些重构意见。', time: '刚才', avatar: '' }
    ];
  };

  const activeMessages = conversations[activeChatId] || defaultConversations[activeChatId] || getFallbackMessages();

  const [inputValue, setInputValue] = useState('');
  const [isFlowExpanded, setIsFlowExpanded] = useState(true);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Code Documentation Generator States
  const [isDocsModalOpen, setIsDocsModalOpen] = useState(false);
  const [selectedCode, setSelectedCode] = useState('');
  const [selectedFileName, setSelectedFileName] = useState('');
  const [isGeneratingDocs, setIsGeneratingDocs] = useState(false);
  const [generatedDocFormat, setGeneratedDocFormat] = useState<'jsdoc' | 'markdown'>('jsdoc');
  const [generatedContent, setGeneratedContent] = useState('');
  const [copiedDoc, setCopiedDoc] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [showHelperGuide, setShowHelperGuide] = useState(false);
  const [isWholeFile, setIsWholeFile] = useState(false);

  const openDocsGenerator = () => {
    setIsDocsModalOpen(true);
    setGeneratedContent('');
    setErrorMsg('');
    setSelectedCode('');
    setSelectedFileName('');
    setShowHelperGuide(false);
    setIsWholeFile(false);
    // Dispatch query to active editor
    window.dispatchEvent(new CustomEvent('soloforge-request-selected-text'));
  };

  useEffect(() => {
    const handleAddToChat = (e: Event) => {
      const customVal = (e as CustomEvent).detail;
      if (customVal && customVal.filePath) {
        setInputValue(prev => {
          const sep = prev.trim() ? '\n\n' : '';
          return prev + sep + `[已关联本地文件: ${customVal.filePath}]\n请针对该文件/模块进行代码审查 and 优化。`;
        });
        setTimeout(() => {
          inputRef.current?.focus();
        }, 50);
      }
    };

    const handleSendCodeToChat = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.text) {
        setPendingAttachment({
          fileName: detail.fileName || '未知文件',
          text: detail.text
        });
        setIsPendingAttachmentExpanded(false);
        setInputValue(prev => {
          if (!prev.trim()) {
            return `请帮我分析并优化 "${detail.fileName || '未知文件'}" 的代码：`;
          }
          return prev;
        });
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus();
          }
        }, 100);
      }
    };

    const handleResponseSelectedText = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        if (detail.text && detail.text.trim()) {
          setSelectedCode(detail.text);
          setIsWholeFile(false);
        } else if (detail.fullContent && detail.fullContent.trim()) {
          setSelectedCode(detail.fullContent);
          setIsWholeFile(true);
        } else {
          setSelectedCode('');
          setIsWholeFile(false);
        }
        setSelectedFileName(detail.fileName || '');
        setErrorMsg('');
      } else {
        setErrorMsg('无法读取当前编辑器选中的代码');
      }
    };

    const handleOpenDocsGenerator = () => {
      openDocsGenerator();
    };

    window.addEventListener('add-to-chat', handleAddToChat);
    window.addEventListener('send-code-to-chat', handleSendCodeToChat);
    window.addEventListener('soloforge-response-selected-text', handleResponseSelectedText);
    window.addEventListener('soloforge-open-docs-generator', handleOpenDocsGenerator);
    
    return () => {
      window.removeEventListener('add-to-chat', handleAddToChat);
      window.removeEventListener('send-code-to-chat', handleSendCodeToChat);
      window.removeEventListener('soloforge-response-selected-text', handleResponseSelectedText);
      window.removeEventListener('soloforge-open-docs-generator', handleOpenDocsGenerator);
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeMessages]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isDocsModalOpen) {
        setIsDocsModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isDocsModalOpen]);

  // ============================================================
  // 资源管理：工具/知识库/技能 弹出选择面板
  // ============================================================
  const DEFAULT_TOOLS_MANIFEST = [
    {
      id: 'obscura',
      name: 'Obscura',
      description: '无头浏览器引擎，支持网页抓取、CDP协议、MCP工具调用',
      group: '浏览器',
      children: [
        { id: 'browser_devtools', name: 'DevTools 调试器', description: 'Chrome 开发者工具集成' },
        { id: 'browser_console', name: 'Console 日志捕获', description: '实时捕获浏览器控制台' },
        { id: 'browser_network', name: 'Network 网络监控', description: '拦截与分析网络请求' },
        { id: 'browser_dom_inspect', name: 'DOM 元素检查器', description: '页面 DOM 树实时浏览' },
        { id: 'browser_screenshot', name: '页面截图工具', description: '对页面进行高清截图' },
        { id: 'browser_perf_trace', name: 'Performance 性能追踪', description: '页面加载与渲染性能分析' },
        { id: 'browser_cookies', name: 'Cookie 管理器', description: '读写浏览器 Cookie 存储' },
      ]
    },
    {
      id: 'browser-use',
      name: 'Browser-Use',
      description: '高层 LLM 浏览器任务编排，LLM 自动规划执行步骤，底层由 Obscura CDP 引擎驱动',
      group: '浏览器',
      children: [
        { id: 'bu_run_task', name: '运行浏览器任务', description: '自然语言描述任务, LLM 自动规划执行步骤' },
        { id: 'bu_pause', name: '暂停任务', description: '暂停正在执行的浏览器任务' },
        { id: 'bu_resume', name: '恢复任务', description: '恢复已暂停的浏览器任务' },
        { id: 'bu_state', name: '任务状态查询', description: '查看浏览器任务执行进度与轨迹' },
        { id: 'bu_screenshot', name: '任务截图', description: '对当前浏览器页面截图' },
        { id: 'bu_history', name: '历史轨迹', description: '查看任务 ReAct 推理历史与结果' },
      ]
    },
    {
      id: 'windows-mcp',
      name: 'Windows-MCP',
      description: 'Windows系统自动化MCP服务器，支持UI交互、应用控制、文件导航',
      group: 'Windows',
      children: [
        { id: 'win_reg_read', name: '注册表读取器', description: '读取 Windows 注册表键值' },
        { id: 'win_service_ctrl', name: '服务控制器', description: '管理 Windows 系统服务启停' },
        { id: 'win_task_scheduler', name: '任务计划程序', description: '创建与管理系统定时任务' },
        { id: 'win_event_log', name: '事件日志查看器', description: '读取 Windows 事件日志' },
        { id: 'win_powershell', name: 'PowerShell 执行器', description: '执行 PowerShell 脚本命令' },
        { id: 'win_firewall', name: '防火墙规则管理', description: '查看与修改防火墙规则' },
        { id: 'win_perfmon', name: '性能监视器', description: 'CPU、内存、磁盘实时监控' },
      ]
    },
  ];

  const [toolsManifest, setToolsManifest] = useState<any[]>(DEFAULT_TOOLS_MANIFEST);
  const [knowledgeManifest, setKnowledgeManifest] = useState<any[]>([]);
  const [skillsManifest, setSkillsManifest] = useState<any[]>([]);
  const [activeTools, setActiveTools] = useState<Set<string>>(new Set());
  const [activeKnowledge, setActiveKnowledge] = useState<Set<string>>(new Set());
  const [activeSkills, setActiveSkills] = useState<Set<string>>(new Set());
  const [customGroups, setCustomGroups] = useState<Record<string, string[]>>({
    tools: ['浏览器', 'Windows'],
    knowledge: ['未分组'],
    skills: ['未分组']
  });
  const [groupAssignments, setGroupAssignments] = useState<Record<string, string>>({});
  const [activeResourcePopover, setActiveResourcePopover] = useState<'tools' | 'knowledge' | 'skills' | null>(null);
  const [editingGroup, setEditingGroup] = useState<{type: 'tools' | 'knowledge' | 'skills', oldName: string, value: string} | null>(null);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [draggedItem, setDraggedItem] = useState<string | null>(null);

  const [popoverHeight, setPopoverHeight] = useState(340);
  const [popoverWidth, setPopoverWidth] = useState(280);
  const isResizingPopover = useRef(false);
  const popoverResizeStart = useRef({ y: 0, h: 340, x: 0, w: 280, dir: 'height' as 'height' | 'width' | 'width-left' });

  // 判断 item 是否为有 children 的父级工具
  const isParentTool = (item: any) => item && Array.isArray(item.children) && item.children.length > 0;
  const getChildIds = (item: any) => isParentTool(item) ? item.children.map((c: any) => c.id) : [];
  // 父级是否"活跃"（父级本身被选中，或任意子项被选中）
  const isParentActiveState = (item: any) => {
    if (!isParentTool(item)) return false;
    if (activeTools.has(item.id)) return true;
    return getChildIds(item).some((cid: string) => activeTools.has(cid));
  };

  // 工具栏计数：只统计父级数量（任意子项选中 = 父级计1）
  const getActiveParentToolCount = () => {
    let count = 0;
    toolsManifest.forEach((item: any) => {
      if (isParentTool(item)) {
        if (isParentActiveState(item)) count++;
      } else {
        if (activeTools.has(item.id)) count++;
      }
    });
    return count;
  };

  // 拖拽：开始拖拽条目
  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    setDraggedItem(id);
  };
  // 拖拽：放置到分组
  const handleGroupDrop = (type: 'tools' | 'knowledge' | 'skills', targetGroup: string, e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    const nextAssign = { ...groupAssignments, [id]: targetGroup };
    setGroupAssignments(nextAssign);
    setDraggedItem(null);
    saveActiveResources(activeTools, activeKnowledge, activeSkills, customGroups, nextAssign);
  };

  // 合并工具清单
  const mergeToolManifests = (serverItems: any[], defaultItems: any[]) => {
    const existingIds = new Set(serverItems.map(i => i.id));
    const merged = [...serverItems];
    for (const item of defaultItems) {
      if (!existingIds.has(item.id)) {
        merged.push(item);
      }
    }
    return merged;
  };

  // 确保浏览器/Windows 分组始终存在
  const ensureDefaultToolGroups = (groups: string[]) => {
    const required = ["浏览器", "Windows"];
    const result = [...groups];
    for (const g of required) {
      if (!result.includes(g)) result.push(g);
    }
    return result;
  };

  // 保存当前选中资源
  const saveActiveResources = (
    tools: Set<string>, knowledge: Set<string>, skills: Set<string>,
    groups?: Record<string, string[]>, assign?: Record<string, string>
  ) => {
    fetch('/api/resources/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tools: Array.from(tools),
        knowledge: Array.from(knowledge),
        skills: Array.from(skills),
        customGroups: groups || customGroups,
        groupAssignments: assign || groupAssignments,
      }),
    }).catch(() => {});
  };

  const handleTogglePopover = (type: 'tools' | 'knowledge' | 'skills', e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveResourcePopover(prev => prev === type ? null : type);
  };

  const toggleItemSelection = (type: 'tools' | 'knowledge' | 'skills', id: string) => {
    if (type === 'tools') {
      const next = new Set(activeTools);
      if (next.has(id)) next.delete(id); else next.add(id);
      setActiveTools(next);
      saveActiveResources(next, activeKnowledge, activeSkills);
    } else if (type === 'knowledge') {
      const next = new Set(activeKnowledge);
      if (next.has(id)) next.delete(id); else next.add(id);
      setActiveKnowledge(next);
      saveActiveResources(activeTools, next, activeSkills);
    } else {
      const next = new Set(activeSkills);
      if (next.has(id)) next.delete(id); else next.add(id);
      setActiveSkills(next);
      saveActiveResources(activeTools, activeKnowledge, next);
    }
  };

  const handleAddNewGroup = (type: 'tools' | 'knowledge' | 'skills') => {
    const currentList = Array.isArray(customGroups[type]) ? customGroups[type] : [];
    const newName = `新分组 ${currentList.length + 1}`;
    setCustomGroups(prev => ({
      ...prev,
      [type]: [...currentList, newName]
    }));
    saveActiveResources(activeTools, activeKnowledge, activeSkills, {
      ...customGroups,
      [type]: [...currentList, newName]
    }, groupAssignments);
  };

  const handleRenameGroup = (type: 'tools' | 'knowledge' | 'skills', oldName: string, newName: string) => {
    if (!newName.trim() || newName === oldName) { setEditingGroup(null); return; }
    const currentList = Array.isArray(customGroups[type]) ? customGroups[type] : [];
    const updatedGroups = currentList.map(g => g === oldName ? newName : g);
    const nextAssign = { ...groupAssignments };
    Object.keys(nextAssign).forEach(k => { if (nextAssign[k] === oldName) nextAssign[k] = newName; });
    setCustomGroups(prev => ({ ...prev, [type]: updatedGroups }));
    setGroupAssignments(nextAssign);
    setEditingGroup(null);
    saveActiveResources(activeTools, activeKnowledge, activeSkills, { ...customGroups, [type]: updatedGroups }, nextAssign);
  };

  const handleDeleteGroup = (type: 'tools' | 'knowledge' | 'skills', groupName: string) => {
    const currentList = Array.isArray(customGroups[type]) ? customGroups[type] : [];
    if (currentList.length <= 1) return;
    const updatedGroups = currentList.filter(g => g !== groupName);
    const fallbackGroup = updatedGroups[0] || "未分组";
    const nextAssign = { ...groupAssignments };
    Object.keys(nextAssign).forEach(k => { if (nextAssign[k] === groupName) nextAssign[k] = fallbackGroup; });
    setCustomGroups(prev => ({ ...prev, [type]: updatedGroups }));
    setGroupAssignments(nextAssign);
    saveActiveResources(activeTools, activeKnowledge, activeSkills, { ...customGroups, [type]: updatedGroups }, nextAssign);
  };

  const toggleGroupSelection = (type: 'tools' | 'knowledge' | 'skills', items: any[], isAllSelected: boolean) => {
    let nextSet: Set<string>;
    if (type === 'tools') {
      nextSet = new Set(activeTools);
    } else if (type === 'knowledge') {
      nextSet = new Set(activeKnowledge);
    } else {
      nextSet = new Set(activeSkills);
    }
    items.forEach(item => {
      if (type === 'tools' && isParentTool(item)) {
        if (isAllSelected) {
          nextSet.delete(item.id);
          getChildIds(item).forEach(cid => nextSet.delete(cid));
        } else {
          nextSet.add(item.id);
          getChildIds(item).forEach(cid => nextSet.add(cid));
        }
      } else {
        if (isAllSelected) nextSet.delete(item.id); else nextSet.add(item.id);
      }
    });
    if (type === 'tools') { setActiveTools(nextSet); saveActiveResources(nextSet, activeKnowledge, activeSkills); }
    else if (type === 'knowledge') { setActiveKnowledge(nextSet); saveActiveResources(activeTools, nextSet, activeSkills); }
    else { setActiveSkills(nextSet); saveActiveResources(activeTools, activeKnowledge, nextSet); }
  };

  // 按分组归类项目
  const getGroupedItems = (type: 'tools' | 'knowledge' | 'skills') => {
    const manifest = type === 'tools' ? toolsManifest : type === 'knowledge' ? knowledgeManifest : skillsManifest;
    const groups = Array.isArray(customGroups[type]) ? customGroups[type] : ['未分组'];
    const assigned = groupAssignments || {};
    const grouped: Record<string, any[]> = {};
    groups.forEach(g => { grouped[g] = []; });
    manifest.forEach((item: any) => {
      const g = assigned[item.id] || item.group || '未分组';
      if (grouped[g]) grouped[g].push(item);
      else grouped[g] = [item];
    });
    return grouped;
  };

  // 加载资源配置（初次挂载）
  useEffect(() => {
    let cancelled = false;
    const fetchResources = () => {
      Promise.all([
        fetch('/api/resources/tools/manifest').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/resources/knowledge/manifest').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/resources/skills/manifest').then(r => r.json()).catch(() => ({ success: false })),
        fetch('/api/resources/active').then(r => r.json()).catch(() => ({ success: false })),
      ]).then(([toolsRes, kbRes, skillsRes, activeRes]) => {
        if (cancelled) return;
        const tManifest = toolsRes.success ? (toolsRes.items || []) : [];
        const kManifest = kbRes.success ? (kbRes.items || []) : [];
        const sManifest = skillsRes.success ? (skillsRes.items || []) : [];
        const finalTManifest = mergeToolManifests(tManifest, DEFAULT_TOOLS_MANIFEST);
        setToolsManifest(finalTManifest);
        setKnowledgeManifest(kManifest);
        setSkillsManifest(sManifest);
        if (activeRes.success && activeRes.active) {
          setActiveTools(new Set(activeRes.active.tools || []));
          setActiveKnowledge(new Set(activeRes.active.knowledge || []));
          setActiveSkills(new Set(activeRes.active.skills || []));
          let toolsGroups: string[];
          if (activeRes.active.customGroups) {
            toolsGroups = activeRes.active.customGroups.tools
              ? ensureDefaultToolGroups(activeRes.active.customGroups.tools)
              : ensureDefaultToolGroups(["未分组"]);
          } else {
            toolsGroups = ensureDefaultToolGroups(
              Array.from(new Set(finalTManifest.map((i: any) => i.group || "未分组"))) as string[]
            );
          }
          const finalAssign = { ...(activeRes.active.groupAssignments || {}) };
          finalTManifest.forEach((item: any) => {
            if (item.group && !finalAssign[item.id]) finalAssign[item.id] = item.group;
          });
          setCustomGroups(prev => {
            const kbGroups = activeRes.active.customGroups?.knowledge?.length
              ? activeRes.active.customGroups.knowledge : ["未分组"];
            const skGroups = activeRes.active.customGroups?.skills?.length
              ? activeRes.active.customGroups.skills : ["未分组"];
            return { tools: toolsGroups, knowledge: kbGroups, skills: skGroups };
          });
          setGroupAssignments(finalAssign);
        } else {
          const toolsGroups = ensureDefaultToolGroups(
            Array.from(new Set(finalTManifest.map((i: any) => i.group || "未分组"))) as string[]
          );
          const assign: Record<string, string> = {};
          finalTManifest.forEach((item: any) => { if (item.group) assign[item.id] = item.group; });
          setCustomGroups({ tools: toolsGroups.length > 0 ? toolsGroups : ensureDefaultToolGroups(["未分组"]), knowledge: ["未分组"], skills: ["未分组"] });
          setGroupAssignments(assign);
        }
      }).catch(err => {
        if (!cancelled) console.error("加载资源失败:", err);
      });
    };
    fetchResources();
    return () => { cancelled = true; };
  }, []);

  // Resize 监听
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingPopover.current) return;
      const dir = popoverResizeStart.current.dir;
      if (dir === 'height') {
        const delta = e.clientY - popoverResizeStart.current.y;
        const newHeight = popoverResizeStart.current.h + delta;
        setPopoverHeight(Math.max(340, Math.min(window.innerHeight - 180, newHeight)));
      } else if (dir === 'width-left') {
        const delta = popoverResizeStart.current.x - e.clientX;
        const newWidth = popoverResizeStart.current.w + delta;
        setPopoverWidth(Math.max(280, Math.min(Math.min(window.innerWidth - 80, 560), newWidth)));
      } else {
        const delta = e.clientX - popoverResizeStart.current.x;
        const newWidth = popoverResizeStart.current.w + delta;
        setPopoverWidth(Math.max(280, Math.min(Math.min(window.innerWidth - 80, 560), newWidth)));
      }
    };
    const handleMouseUp = () => { isResizingPopover.current = false; };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleGenerateDocs = async (format: 'jsdoc' | 'markdown') => {
    if (!selectedCode.trim()) {
      setErrorMsg('请提供或选择一些代码块来进行文档/注释生成。');
      return;
    }
    setIsGeneratingDocs(true);
    setErrorMsg('');
    setGeneratedContent('');

    try {
      const formatPrompt = format === 'jsdoc' 
        ? `请针对以下代码段生成一段标准的 JSDoc 注释。
要求：
1. 包含核心功能、输入参数名、输入类型、返回值说明、返回值类型。
2. 语言使用简体中文。
3. 请【直接输出】多行注释段（形如 /** ... */），不要将 JSDoc 包裹在代码块中，不要输出多余解释或 Markdown 自带的\`\`\``
        : `请针对以下代码段生成一份精致的 Markdown 代码解析文档。
要求：
1. 结构包括：核心功能概述、逻辑思路精解（步骤或重点说明）、异常/安全边界与使用示例。
2. 格式优雅，使用清晰的 Markdown 标头、粗体和列表。
3. 语言使用简体中文。
4. **注意**：由于之后可能会插入至代码中，请直接输出生成的文档本体，确保可以用 /* ... */ 注释块进行包裹。`;

      const response = await fetch('/api/ai/coding-assist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file: selectedFileName || 'App.tsx',
          content: selectedCode,
          promptType: 'custom',
          customPrompt: formatPrompt,
        }),
      });

      const data = await response.json();
      if (data.success) {
        let textResult = data.rawResponse || '';
        // Clean out any outer markdown code blocks if the AI accidentally wrapped them
        textResult = textResult.replace(/^```[a-zA-Z0-9]*\n/, '').replace(/\n```$/, '');
        setGeneratedContent(textResult);
      } else {
        setErrorMsg(data.error || 'AI 智能体文档生成已禁用。');
      }
    } catch (err: any) {
      console.error(err);
      setErrorMsg(`服务请求故障，请稍后重试: ${err.message}`);
    } finally {
      setIsGeneratingDocs(false);
    }
  };

  const handleInsertToCodeHead = () => {
    if (!generatedContent) return;
    
    let commentText = '';
    if (generatedDocFormat === 'jsdoc') {
      const cleanContent = generatedContent.trim();
      if (cleanContent.startsWith('/**') || cleanContent.startsWith('/*')) {
        commentText = cleanContent;
      } else {
        commentText = `/**\n * ${cleanContent.replace(/\n/g, '\n * ')}\n */`;
      }
    } else {
      commentText = `/*\n================================================================\n代码模块说明与剖析 (Markdown 格式详情)\n================================================================\n\n${generatedContent.trim()}\n*/`;
    }

    // Dispatch custom event to insert in the editor!
    window.dispatchEvent(new CustomEvent('soloforge-insert-comment-to-head', {
      detail: {
        comment: commentText
      }
    }));

    setIsDocsModalOpen(false);
  };

  const handleExportDoc = () => {
    if (!generatedContent) return;
    const filename = `${selectedFileName ? selectedFileName.replace(/\.[^/.]+$/, "") : "code"}_doc.${generatedDocFormat === 'jsdoc' ? 'jsdoc.txt' : 'md'}`;
    const blob = new Blob([generatedContent], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ==========================================
  // 【后端对接提示 - 发送消息与流式响应 (Streaming/SSE) 对接规约】
  // 后期接入真实后端（例如 Node.js Express + Gemini API 代理或者 Python FastAPI 等）时：
  // 1. 可以改写此函数，通过 fetch('/api/chat', { method: 'POST', body: JSON.stringify({ message: finalContent, chatId: activeChatId, settings: activeSettings }) })
  // 2. 为了提升用户体验，强烈建议使用 Server-Sent Events (SSE) 协议来进行 Stream 流式渲染回答。
  // 3. 在接收到 SSE chunks 时，逐步追加局部 assistant 消息内容至当前 messages array
  // 4. 发送成功后分别将 User Message 与 Assistant Message 写入消息表（关联 chat_id）进行持久化保存
  // ==========================================
  const handleSend = () => {
    if (!inputValue.trim() && !pendingAttachment) return;

    const finalContent = inputValue.trim() || `请帮我分析如下来自于 "${pendingAttachment?.fileName}" 的代码。`;

    const userMsg: ChatMessage = {
      sender: 'user',
      content: finalContent,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      avatar: '',
    };

    if (pendingAttachment) {
      userMsg.attachment = {
        fileName: pendingAttachment.fileName,
        text: pendingAttachment.text
      };
    }

    const currentChatMsgs = [...activeMessages, userMsg];
    setConversations((prev) => ({
      ...prev,
      [activeChatId]: currentChatMsgs,
    }));
    setInputValue('');
    setPendingAttachment(null);

    // Execute actual cloud API integration instead of simulated wait times
    setIsGenerating(true);
    // 重置流式状态
    setStreamState({
      workerOutputs: [],
      reply: '',
      scores: [],
      judgeChosen: [],
      judgeReasoning: '',
      auditFindings: [],
      deliver: '',
      suggestEnables: [],
      toolCalls: []
    });

    // ==========================================
    // 构造请求体（设计文档：UI/连接.md §3.1 §4.1）
    // - mainProvider / subProviders / candidateProviders 都从 modelProviderMap 拼出
    // - subProvider 必须 BOTH enabledInSettings=true AND 在 secModels 列表里
    // - candidateProvider 只传脱敏字段
    // ==========================================
    const mainEntry = modelProviderMap[mainModel];
    if (!mainEntry || !mainEntry.apiKey) {
      const assistantMsg: ChatMessage = {
        sender: 'assistant',
        content: `❌ **主模型未配置**：请在「设置 → 模型」中测试通过主模型「${mainModel}」后再试。`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        avatar: ''
      };
      setConversations((prev) => ({ ...prev, [activeChatId]: [...currentChatMsgs, assistantMsg] }));
      setIsGenerating(false);
      return;
    }

    // 副模型：必须是 secModels 列表里 + map 里存在 + enabledInSettings=true
    const subModels = (secModels || []).map(s => s.id || s.name);
    const subEntries = subModels
      .map(name => modelProviderMap[name])
      .filter((e): e is NonNullable<typeof e> => !!e && e.enabledInSettings && !!e.apiKey);

    // 候选副模型：所有 enabledInSettings=true 但不在 secModels 里的
    const candidateEntries = Object.values(modelProviderMap)
      .filter(e => e.enabledInSettings && !!e.apiKey && !subModels.includes(e.model));

    const reqBody = {
      mode: permissionMode,
      query: finalContent,
      history: activeMessages.map(m => ({ sender: m.sender, content: m.content })),
      fileContext: selectedFile ? { name: selectedFile, content: editorContent } : undefined,
      toolCallMode: hashlineAgentEnabled ? 'hashline' : undefined,
      mainProvider: {
        baseUrl: mainEntry.baseUrl,
        apiKey: mainEntry.apiKey,
        model: mainEntry.model
      },
      subProviders: subEntries.map(e => ({ baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model })),
      candidateProviders: candidateEntries.map(e => ({
        displayName: e.model,
        providerName: e.providerName,
        modelName: e.model,
        baseUrl: e.baseUrl
        // 故意不传 apiKey
      }))
    };
    setLastReqBody(reqBody);

    fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: finalContent,
        history: activeMessages.map(m => ({ sender: m.sender, content: m.content })),
        activeFile: selectedFile ? { name: selectedFile, content: editorContent } : null,
        mainModel,
        secModels,
        mixedTasks,
        activeSettings
      })
    })
    .then(async (res) => {
      if (!res.ok) {
        const isJson = res.headers.get('content-type')?.includes('application/json');
        const data = isJson ? await res.json() : null;
        throw new Error(data?.error || `服务器响应错误: ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error('无法读取响应流，请检查浏览器兼容性');
      }

      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let isFirstChunk = true;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Buffer leftovers

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') {
              continue;
            }
            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.error) {
                throw new Error(parsed.error);
              }
              const chunkText = parsed.text;
              if (chunkText) {
                if (isFirstChunk) {
                  isFirstChunk = false;
                  setIsGenerating(false); // Remove global centering loader bubble when first text block is received

                  const assistantMsg: ChatMessage = {
                    sender: 'assistant',
                    content: chunkText,
                    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                    avatar: '',
                  };
                  setConversations((prev) => ({
                    ...prev,
                    [activeChatId]: [...currentChatMsgs, assistantMsg],
                  }));
                } else {
                  setConversations((prev) => {
                    const currentList = prev[activeChatId] || [];
                    if (currentList.length === 0) return prev;
                    const newList = [...currentList];
                    const lastMsg = { ...newList[newList.length - 1] };
                    if (lastMsg.sender === 'assistant') {
                      lastMsg.content += chunkText;
                      newList[newList.length - 1] = lastMsg;
                    }
                    return {
                      ...prev,
                      [activeChatId]: newList,
                    };
                  });
                }
              }
            } catch (e) {
              console.warn('解析流出错:', e);
            }
          }
        }
      }
    })
    .catch((err) => {
      console.error(err);
      const assistantMsg: ChatMessage = {
        sender: 'assistant',
        content: `❌ **AI 助手已禁用**：${err.name === 'TypeError' ? '无法连接到服务端。请检查服务端状态及网络联通性。' : err.message}\n\n*(提示：AI 助手模块已从本项目移除。若发生报错，请使用其他代码生成工具)*`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        avatar: '',
      };
      setConversations((prev) => ({
        ...prev,
        [activeChatId]: [...currentChatMsgs, assistantMsg],
      }));
    })
    .finally(() => {
      setIsGenerating(false);
    });
  };

  // ==========================================
  // 阶段 0 建议启用 - 用户点"启用并重发"后回调
  // 把 lastReqBody 里 subProviders 加上该 candidate，并附 enableDecision
  // ==========================================
  const handleAcceptEnable = (candidateName: string) => {
    if (!lastReqBody) return;
    const entry = modelProviderMap[candidateName];
    if (!entry || !entry.apiKey) return;
    // 把 candidate 提升为 sub
    const newSub = { baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model };
    const newReqBody = {
      ...lastReqBody,
      subProviders: [...(lastReqBody.subProviders as any[]), newSub],
      candidateProviders: (lastReqBody.candidateProviders as any[]).filter((c: any) => c.modelName !== candidateName),
      enableDecision: { candidateName: candidateName, accept: true }
    };
    setStreamState({ workerOutputs: [], reply: '', scores: [], judgeChosen: [], judgeReasoning: '', auditFindings: [], deliver: '', suggestEnables: [], toolCalls: [] });
    setIsGenerating(true);
    fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newReqBody)
    })
    .then(res => res.ok && res.body ? streamSse(res.body, (evt) => handlePhase(evt, activeMessages)) : Promise.reject(res.status))
    .catch(err => console.error('[handleAcceptEnable]', err))
    .finally(() => setIsGenerating(false));
  };

  // ==========================================
  // SSE 流式解析 - 把后端 phase 事件投影到 streamState + 最终消息
  // ==========================================
  const streamSse = (body: ReadableStream<Uint8Array>, onEvent: (evt: any) => void): Promise<void> => {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    return (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            onEvent(evt);
          } catch { /* 忽略非 JSON 行 */ }
        }
      }
    })();
  };

  // ==========================================
  // handlePhase - 处理单个 SSE 事件，更新流式状态 / 提交 assistant 消息
  // ==========================================
  const handlePhase = (evt: any, currentChatMsgs: ChatMessage[]) => {
    // 先更新 streamState（驱动 UI 子组件）
    setStreamState((prev) => {
      const next = { ...prev };
      switch (evt.phase) {
        case 'phase0_skip':
          // 静默
          break;
        case 'suggest_enable':
          next.suggestEnables = [...prev.suggestEnables, {
            candidateName: evt.candidateName,
            expectedGain: evt.expectedGain,
            reason: evt.reason ?? ''
          }];
          break;
        case 'dispatch':
          // 初始化 worker 列表
          next.workerOutputs = (evt.subtasks as string[]).map((m, i) => ({
            workerIdx: i, modelName: m, content: '', status: 'pending'
          }));
          break;
        case 'worker_start':
          next.workerOutputs = prev.workerOutputs.map(w =>
            w.workerIdx === evt.workerIdx ? { ...w, status: 'streaming' } : w
          );
          break;
        case 'worker_done':
          next.workerOutputs = prev.workerOutputs.map(w =>
            w.workerIdx === evt.workerIdx
              ? { ...w, status: evt.content?.startsWith('⚠️') ? 'error' : 'done', content: evt.content ?? '' }
              : w
          );
          break;
        case 'reply':
          next.reply = prev.reply + (evt.delta ?? '');
          break;
        case 'audit_stream':
          // 专家模式：审计流式
          next.reply = prev.reply + (evt.delta ?? '');
          break;
        case 'score':
          next.scores = evt.scores ?? [];
          break;
        case 'judge':
          next.judgeChosen = evt.chosen ?? [];
          next.judgeReasoning = evt.reasoning ?? '';
          break;
        case 'audit':
          next.auditFindings = evt.findings ?? [];
          break;
        case 'deliver':
          next.deliver = prev.deliver + (evt.delta ?? '');
          break;
        case 'tool_call': {
          // Hashline 工具调用事件
          // 按 callId upsert(running → success/error)
          const idx = prev.toolCalls.findIndex(t => t.id === evt.callId);
          const status = evt.status;
          const kind = evt.tool;
          const stamp = evt.timestamp ?? Date.now();
          const baseList = [...prev.toolCalls];
          if (kind === 'hashline.read') {
            const tc: import('../types').HashlineReadCall = {
              id: evt.callId,
              kind: 'hashline.read',
              status,
              filePath: evt.filePath ?? '',
              version: evt.version,
              errorCode: evt.errorCode,
              timestamp: stamp,
            };
            if (idx >= 0) baseList[idx] = tc; else baseList.push(tc);
          } else if (kind === 'hashline.edit') {
            const tc: import('../types').HashlineEditCall = {
              id: evt.callId,
              kind: 'hashline.edit',
              status,
              filePath: evt.filePath ?? '',
              op: evt.op ?? 'replace',
              diff: evt.diff,
              diffSummary: evt.diffSummary,
              removedLineCount: evt.removedLineCount,
              insertedLineCount: evt.insertedLineCount,
              newVersion: evt.version,
              errorCode: evt.errorCode,
              timestamp: stamp,
            };
            if (idx >= 0) baseList[idx] = tc; else baseList.push(tc);
          } else {
            const tc: import('../types').HashlineBatchCall = {
              id: evt.callId,
              kind: 'hashline.batch',
              status,
              total: evt.results?.length ?? 1,
              succeeded: status === 'success' ? (evt.results?.length ?? 0) : (evt.results?.length ?? 0),
              failedAt: evt.failedAt,
              errorCode: evt.errorCode,
              results: evt.results as any,
              timestamp: stamp,
            };
            if (idx >= 0) baseList[idx] = tc; else baseList.push(tc);
          }
          next.toolCalls = baseList;
          break;
        }
        case 'warn':
          console.warn('[orchestrator warn]', evt.msg);
          break;
        case 'done': {
          // 提交最终 assistant 消息（覆盖中间流）
          const finalReply = evt.reply ?? prev.deliver ?? prev.reply;
          const findings = evt.audit ?? prev.auditFindings;
          let content = finalReply;
          if (findings && findings.length > 0) {
            content += '\n\n---\n\n## ⚠️ 审计提示\n\n' +
              findings.map((f: any) => `- **[${f.severity?.toUpperCase()}]** ${f.target}\n  建议：${f.suggestion}`).join('\n');
          }
          if (next.suggestEnables.length > 0) {
            content += '\n\n---\n\n## 💡 建议启用\n\n' +
              next.suggestEnables.map(s => `- **${s.candidateName}**（预期增益 ${(s.expectedGain * 100).toFixed(0)}%）：${s.reason}`).join('\n');
          }
          const assistantMsg: ChatMessage = {
            sender: 'assistant',
            content,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            avatar: '',
            toolCalls: next.toolCalls.length > 0 ? next.toolCalls : undefined,
          };
          setConversations((p) => ({ ...p, [activeChatId]: [...currentChatMsgs, assistantMsg] }));
          break;
        }
        case 'error':
          console.error('[orchestrator error]', evt.msg);
          break;
        default:
          // 未知 phase - 不处理
          break;
      }
      return next;
    });
  };

  const pMapPlaceholder: Record<string, string> = { professional: "专业", sarcastic: "毒舌", zen: "禅意", geek: "极客" };
  const activeChatIDPrefix = activeChatId.length > 5 ? activeChatId.slice(-4) : activeChatId;

  return (
    <div className="flex-1 h-full bg-bg flex flex-col overflow-hidden">
      {/* Active Dialogue Header Bar */}
      <div className="h-14 border-b border-outline/50 bg-surface/85 backdrop-blur px-5 flex items-center justify-between shrink-0 select-none z-30">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 rounded-lg bg-primary/10 text-primary shrink-0 flex items-center justify-center">
            {React.createElement(activeChatIcon, { className: "w-4 h-4 text-primary shrink-0" })}
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold text-on-surface flex items-center gap-2">
              <span className="truncate">{activeChatTitle}</span>
              <span className="shrink-0 text-[8.5px] font-mono font-bold text-on-surface/30 px-1 py-0.2 border border-outline/35 rounded bg-bg">ID: {activeChatIDPrefix}</span>
            </div>
            <div className="text-[10px] text-on-surface/50 mt-0.5 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <button 
                onClick={() => window.dispatchEvent(new CustomEvent('soloforge-open-agent-settings', { detail: { id: activeChatId, title: activeChatTitle } }))}
                className="truncate font-sans font-medium hover:text-primary hover:underline cursor-pointer flex items-center gap-0.5 group"
                title="点击配置智能体角色表情、状态、回复语调与性格"
                id="agent-role-summary-btn"
              >
                <span>智能体角色：</span>
                <span className="text-primary font-semibold group-hover:text-primary/80">{getSettingsSummary(activeSettings)}</span>
                <SlidersHorizontal className="w-2.5 h-2.5 ml-1 select-none text-primary opacity-60 group-hover:opacity-100 transition-opacity" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 relative shrink-0">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('soloforge-open-agent-settings', { detail: { id: activeChatId, title: activeChatTitle } }))}
            className="flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary hover:text-primary/90 transition-all duration-150 cursor-pointer border border-primary/20 hover:border-primary/35 shadow-sm"
            title="定制智能体性格、表情状态与回复语调"
            id="chat-header-agent-settings-btn"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>智能体配置</span>
          </button>
        </div>
      </div>

      {/* Scrollable Conversation Stream */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 select-text scrollbar-thin scrollbar-thumb-outline/50"
      >
        <div className="max-w-5xl lg:max-w-[94%] xl:max-w-[90%] mx-auto w-full flex flex-col space-y-5 py-2 px-4 md:px-6">
          {activeMessages.map((msg, index) => {
            const isUser = msg.sender === 'user';
            return (
              <motion.div 
                key={index}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex flex-col gap-2.5 ${isUser ? 'items-end' : 'items-start'}`}
              >
                {/* Header Row: Avatar + Info */}
                <div className={`flex gap-3 items-center mb-1 ${isUser ? 'flex-row-reverse' : ''}`}>
                  {/* Avatar block — 始终使用本地兜底，不加载外链头像 (CSP 安全) */}
                  {isUser ? (
                    <div
                      role="img"
                      aria-label="User"
                      className="w-11 h-11 rounded-full shrink-0 border border-primary/25 shadow-sm flex items-center justify-center"
                      style={{
                        background:
                          'linear-gradient(135deg, #ffde82 0%, #f5b461 50%, #c97f3a 100%)',
                        color: '#121414',
                        fontSize: 20,
                        fontWeight: 700,
                        lineHeight: 1,
                      }}
                    >
                      U
                    </div>
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-on-surface/5 border border-on-surface/10 flex items-center justify-center shrink-0">
                      <ModelIcon modelName={mainModel || 'GPT-4o'} size={32} className="shrink-0" />
                    </div>
                  )}

                  {/* Info block (Username/Model + Time) */}
                  <div className={`flex items-center gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
                    <span className={`text-[11px] font-bold ${isUser ? 'text-primary/95 text-right' : 'text-[#3b82f6]'}`}>
                      {isUser ? '你' : (mainModel || 'GPT-4o')}
                    </span>
                    <span className="text-[9px] text-on-surface/30 font-mono tracking-wide">{msg.time}</span>
                  </div>
                </div>

                {/* Content block: aligned on right or left */}
                <div className={`flex flex-col gap-1 max-w-[88%] font-sans text-left ${isUser ? 'pr-3 pl-[58px] items-end' : 'pl-[58px] pr-3 items-start'}`}>
                  <div className={`px-3.5 py-2.5 rounded-xl text-[12px] leading-relaxed select-text space-y-1.5 w-fit max-w-full overflow-hidden border ${isUser ? 'bg-primary/8 border-primary/30 text-on-surface' : 'bg-surface/50 border-outline/30 text-on-surface'}`}>
                    <FormatChatMessage content={msg.content} />
                    {msg.attachment && (
                      <CollapsibleCodeBlock
                        fileName={msg.attachment.fileName}
                        text={msg.attachment.text}
                      />
                    )}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="flex flex-col gap-1.5 pt-1 border-t border-outline/20 mt-1">
                        <div className="text-[9px] uppercase tracking-wider text-on-surface/40 font-semibold">
                          工具调用 · {msg.toolCalls.length}
                        </div>
                        {msg.toolCalls.map((tc) => (
                          <ToolCallCard key={tc.id} call={tc} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}

          {isGenerating && (
            <motion.div 
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col gap-2.5 text-left"
            >
              {/* Header Row: Avatar + Loading info (Center-aligned) */}
              <div className="flex gap-3.5 items-center mb-1">
                {/* Avatar block with overlapping spinner */}
                <div className="relative w-11 h-11 rounded-full bg-on-surface/5 border border-on-surface/10 flex items-center justify-center shrink-0">
                  <ModelIcon modelName={mainModel || 'GPT-4o'} size={32} className="shrink-0 opacity-40 animate-pulse" />
                  <Loader2 className="absolute inset-0 w-full h-full text-primary/80 animate-spin p-2" />
                </div>

                {/* Info block (Username/Model + Loading status) */}
                <div className="flex items-center gap-2 animate-pulse font-sans">
                  <span className="text-[11px] font-bold text-[#3b82f6]">
                    {mainModel} 智脑中枢正在计算中...
                  </span>
                  <span className="text-[9px] text-on-surface/30 font-mono">排队分析中</span>
                </div>
              </div>

              {/* 流式面板：6 个子组件按出现顺序堆叠 */}
              <div className="flex flex-col gap-2 max-w-[95%] font-sans pl-[58px] text-left">
                <SuggestEnableView items={streamState.suggestEnables} onAccept={handleAcceptEnable} />
                <WorkerOutputsView outputs={streamState.workerOutputs} />
                {permissionMode === 'ultimate' && <ScoresView scores={streamState.scores} />}
                {permissionMode === 'ultimate' && <JudgeView chosen={streamState.judgeChosen} reasoning={streamState.judgeReasoning} />}
                {streamState.reply && permissionMode !== 'ultimate' && (
                  <FinalReplyView
                    content={streamState.reply}
                    label={permissionMode === 'expert' ? '主模型汇总 + 三段式审计' : '主模型汇总'}
                  />
                )}
                {permissionMode === 'ultimate' && streamState.deliver && (
                  <FinalReplyView content={streamState.deliver} label="Deliverer 整合交付" />
                )}
                {streamState.toolCalls.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <div className="text-[9px] uppercase tracking-wider text-on-surface/40 font-semibold">
                      工具调用进行中 · {streamState.toolCalls.length}
                    </div>
                    {streamState.toolCalls.map((tc) => (
                      <ToolCallCard key={tc.id} call={tc} />
                    ))}
                  </div>
                )}
                {streamState.auditFindings.length > 0 && (
                  <AuditView findings={streamState.auditFindings} />
                )}
              </div>
            </motion.div>
          )}

        {/* 1:1 Static Agent Execution Process (placed in between messages or at the bottom for fidelity to screenshot) */}
        <div className="flex flex-col gap-2.5 mt-4 text-left">
          <div className="flex gap-3.5 items-center mb-1">
            <div className="w-11 h-11 rounded-full bg-on-surface/5 border border-on-surface/10 flex items-center justify-center shrink-0">
              <ModelIcon modelName="GPT-4o" size={32} className="shrink-0" />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold text-[#3b82f6]">GPT-4o</span>
              <span className="text-[9px] text-on-surface/30 font-mono">12:00:01</span>
            </div>
          </div>

          <div className="flex flex-col gap-1 max-w-[90%] font-sans pl-[58px] text-left">
            <div className="bg-surface border border-outline/30 p-3.5 rounded-xl text-on-surface text-[12px] leading-relaxed space-y-3">
              <p className="text-on-surface/90">好的，我将为你创建一个完整的博客系统，技术栈为 <strong className="text-on-surface font-black">Vue3 + Node.js + MongoDB</strong>。我们将按下述步骤进行：</p>
              
              <ol className="list-decimal list-inside pl-1 text-[11.5px] text-on-surface/80 space-y-0.5 leading-normal">
                <li>设计数据库结构</li>
                <li>创建后端 API 接口</li>
                <li>开发前端页面</li>
                <li>实现评论功能</li>
                <li>联调与测试</li>
              </ol>

              {/* AI Execution Flow Collapsible Card */}
              <div className="border border-outline/30 rounded-lg overflow-hidden bg-bg/50">
                {/* Flow Header */}
                <div 
                  onClick={() => setIsFlowExpanded(!isFlowExpanded)}
                  className="p-2.5 bg-surface border-b border-outline/30 flex items-center justify-between text-[11px] cursor-pointer"
                >
                  <div className="flex items-center gap-1.5 text-on-surface/80">
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isFlowExpanded ? 'rotate-0' : '-rotate-90'}`} />
                    <span className="font-semibold">AI 执行流程</span>
                    <span className="text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded font-mono font-bold">进行中 (3/5)</span>
                  </div>
                  <span className="text-[10px] text-on-surface/40 font-mono">23% CPU</span>
                </div>

                {/* Flow steps container */}
                {isFlowExpanded && (
                  <div className="p-3 space-y-3.5 text-[11px] font-mono">
                    {/* Step 1 */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                        <span>分析需求和设计页面结构</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-green-500">已完成</span>
                        <span className="text-on-surface/30">00:01:23</span>
                      </div>
                    </div>

                    {/* Step 2 */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                        <span>创建数据库设计</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-green-500">已完成</span>
                        <span className="text-on-surface/30">00:00:45</span>
                      </div>
                    </div>

                    {/* Step 3 */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin shrink-0" />
                          <span className="font-bold text-white">搭建后端 API 服务</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-blue-500 font-bold">进行中</span>
                          <span className="text-blue-400 font-bold">65%</span>
                        </div>
                      </div>

                      {/* Substeps */}
                      <div className="pl-5 border-l border-outline/30 ml-1.5 space-y-2 mt-1 py-1">
                        <div className="flex items-center justify-between text-[10.5px]">
                          <span className="text-on-surface/80">3.1 用户模块 API</span>
                          <div className="flex gap-2">
                            <span className="text-green-500">已完成</span>
                            <span className="text-on-surface/30">00:00:30</span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-[10.5px]">
                          <span className="text-on-surface font-bold">3.2 文章模块 API</span>
                          <div className="flex gap-2 font-bold text-blue-400">
                            <span>进行中</span>
                            <span>60%</span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-[10.5px] text-on-surface/40">
                          <span>3.3 评论模块 API</span>
                          <span>等待中</span>
                        </div>
                      </div>
                    </div>

                    {/* Step 4 */}
                    <div className="flex items-center justify-between text-on-surface/50">
                      <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-on-surface/30 shrink-0" />
                        <span>4. 创建前端页面组件</span>
                      </div>
                      <div className="flex gap-3">
                        <span>等待中</span>
                        <span>0%</span>
                      </div>
                    </div>

                    {/* Step 5 */}
                    <div className="flex items-center justify-between text-on-surface/50">
                      <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-on-surface/30 shrink-0" />
                        <span>5. 集成前后端</span>
                      </div>
                      <div className="flex gap-3">
                        <span>等待中</span>
                        <span>0%</span>
                      </div>
                    </div>

                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>

      {/* Mini Command Shortcuts (技能, 记忆, 上传文件, 工具, etc.) */}
      <div 
        style={{ '--color-primary': primaryColorTargets?.skillBar ? 'var(--color-main-primary)' : '#8c8c8c' } as React.CSSProperties}
        className="px-4 py-1.5 border-t border-outline/50 flex items-center text-[10px] text-on-surface/60 font-medium select-none bg-surface/80"
      >
        <div className="max-w-5xl lg:max-w-[94%] xl:max-w-[90%] mx-auto w-full flex items-center gap-2 px-4 md:px-6 relative">
          <button className="flex items-center gap-1.5 px-3 py-1 rounded-lg hover:text-primary hover:bg-on-surface/5 transition-all cursor-pointer font-sans text-[11px] text-primary border border-transparent">
            <Brain className="w-3.5 h-3.5 text-primary" />
            <span>记忆</span>
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1 rounded-lg hover:text-primary hover:bg-on-surface/5 transition-all cursor-pointer font-sans text-[11px] text-primary border border-transparent">
            <Upload className="w-3.5 h-3.5 text-primary" />
            <span>上传文件</span>
          </button>

          <div className="w-px h-4 bg-primary/12 shrink-0 mx-1" />

          {(['skills', 'tools', 'knowledge'] as const).map((resType, idx, arr) => {
            const labels = { skills: '技能', tools: '工具', knowledge: '知识库' };
            const isActive = activeResourcePopover === resType;
            const hasSelected = resType === 'skills' ? activeSkills.size > 0
              : resType === 'tools' ? getActiveParentToolCount() > 0
              : activeKnowledge.size > 0;
            const displayCount = resType === 'tools' ? getActiveParentToolCount()
              : resType === 'skills' ? activeSkills.size
              : activeKnowledge.size;
            return (
              <React.Fragment key={resType}>
                <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={(e) => handleTogglePopover(resType, e)}
                  className={`flex items-center justify-center gap-1.5 px-3 py-1 rounded-lg transition-all cursor-pointer font-sans text-[11px] border shrink-0 ${
                    isActive
                      ? 'bg-primary/20 border-primary text-primary shadow-sm'
                      : hasSelected
                      ? 'bg-primary/8 border-primary/25 text-primary font-bold shadow-sm'
                      : 'bg-transparent border-transparent text-on-surface/65 hover:bg-on-surface/5 hover:text-primary'
                  }`}
                >
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="truncate leading-none">{labels[resType]}</span>
                    <span className={`${hasSelected ? '' : 'text-transparent'}`}>·</span>
                    <span className={`w-[2ch] text-left leading-none shrink-0 ${hasSelected ? '' : 'text-transparent'}`}>
                      {hasSelected ? displayCount : '·'}
                    </span>
                  </div>
                  <ChevronDown className={`w-2.5 h-2.5 opacity-65 transition-transform duration-200 ${isActive ? 'rotate-180 text-primary' : ''} shrink-0`} />
                </button>

                {/* 弹出面板 - 向右弹出 */}
                {isActive && (() => {
                  const type = resType;
                  const activeSet = type === 'skills' ? activeSkills : type === 'tools' ? activeTools : activeKnowledge;
                  const groupedItems = getGroupedItems(type);
                  return (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setActiveResourcePopover(null)} />
                      <div
                        className="absolute left-full top-0 ml-2 z-50 flex flex-col overflow-hidden border border-outline/20 bg-surface/95 backdrop-blur-md shadow-2xl rounded-xl text-left font-sans select-none"
                        style={{ height: popoverHeight, width: popoverWidth }}
                        onWheel={(e) => e.stopPropagation()}
                      >
                        {/* Header */}
                        <div className="px-2 py-1.5 flex items-center justify-between border-b border-outline/15 shrink-0">
                          <span className="text-[10px] font-bold text-on-surface/80 tracking-wider uppercase select-none">{labels[type]}</span>
                          <div className="flex items-center gap-1">
                            <button onClick={() => handleAddNewGroup(type)} className="p-0.5 rounded hover:bg-on-surface/5 text-on-surface/40 hover:text-primary transition-colors cursor-pointer" title="新建分组">
                              <FolderPlus className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => setActiveResourcePopover(null)} className="p-0.5 rounded hover:bg-on-surface/5 text-on-surface/40 hover:text-primary transition-colors cursor-pointer" title="关闭">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Scrollable content */}
                        <div className="flex-1 overflow-y-auto space-y-1 p-1.5 text-[10px]" style={{ maxHeight: popoverHeight - 32 }}>
                          {Object.entries(groupedItems).map(([groupName, groupItems]) => {
                            const allSelected = groupItems.length > 0 && groupItems.every((item: any) => {
                            if (type === 'tools' && isParentTool(item)) return isParentActiveState(item);
                            return activeSet.has(item.id);
                          });
                            return (
                              <div key={groupName} className="space-y-1 group/title"
                                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('ring-1', 'ring-primary/40'); }}
                                onDragLeave={(e) => { e.currentTarget.classList.remove('ring-1', 'ring-primary/40'); }}
                                onDrop={(e) => { e.currentTarget.classList.remove('ring-1', 'ring-primary/40'); handleGroupDrop(type, groupName, e); }}
                              >
                                {/* Group header */}
                                <div className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-on-surface/[0.02]">
                                  <button
                                    onClick={() => toggleGroupSelection(type, groupItems, allSelected)}
                                    className={`flex items-center justify-center shrink-0 ${allSelected ? 'opacity-100' : 'opacity-30'} hover:opacity-100 transition-all cursor-pointer`}
                                    title={allSelected ? '取消全选' : '全选'}
                                  >
                                    <Circle className={`w-3.5 h-3.5 ${allSelected ? 'text-primary fill-primary/20' : 'text-on-surface/30'}`} />
                                  </button>

                                  <div className="flex items-center gap-0.5 min-w-0 flex-1">
                                    {editingGroup?.type === type && editingGroup?.oldName === groupName ? (
                                      <input
                                        autoFocus
                                        defaultValue={groupName}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') handleRenameGroup(type, groupName, (e.target as HTMLInputElement).value);
                                          if (e.key === 'Escape') setEditingGroup(null);
                                        }}
                                        onBlur={(e) => handleRenameGroup(type, groupName, e.target.value)}
                                        className="w-full bg-transparent border-b border-primary/50 text-[10px] font-bold text-on-surface outline-none px-0.5 py-0"
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                    ) : (
                                      <span className="text-[10px] font-bold tracking-wide text-on-surface/60 truncate">
                                        {groupName}
                                      </span>
                                    )}
                                    {editingGroup?.type !== type || editingGroup?.oldName !== groupName ? (
                                      <>
                                        <button onClick={() => setEditingGroup({ type, oldName: groupName, value: groupName })} className="p-0.5 rounded hover:bg-on-surface/5 text-on-surface/30 hover:text-on-surface transition-colors cursor-pointer" title="重命名分组">
                                          <Pencil className="w-2.5 h-2.5" />
                                        </button>
                                        {(customGroups[type] || []).length > 1 && (
                                          <button onClick={() => handleDeleteGroup(type, groupName)} className="p-0.5 rounded hover:bg-red-500/15 text-on-surface/30 hover:text-red-400 transition-colors cursor-pointer" title="删除此分组（项目将移至其他分组）">
                                            <Trash2 className="w-2.5 h-2.5" />
                                          </button>
                                        )}
                                      </>
                                    ) : null}
                                  </div>
                                </div>

                                {/* Item list */}
                                <div className="space-y-1 pl-0.5 min-h-[16px] border-l border-dashed border-outline/10 ml-2">
                                  {groupItems.length === 0 ? (
                                    <div className="text-[8.5px] text-on-surface/30 px-2 py-1 italic">拖拽项目至此分组</div>
                                  ) : (
                                    groupItems.map((item: any) => {
                                      const isParent = type === 'tools' && isParentTool(item);
                                      const isExpanded = isParent && expandedTools.has(item.id);
                                      const isParentActive = isParent ? isParentActiveState(item) : activeSet.has(item.id);
                                      const isParentFullyActive = isParent && activeSet.has(item.id);

                                      const handleToolToggle = () => {
                                        if (type !== 'tools') return;
                                        const parentId = item.id;
                                        const childIds = getChildIds(item);
                                        const nextSet = new Set(activeTools);
                                        if (nextSet.has(parentId)) {
                                          nextSet.delete(parentId);
                                          childIds.forEach(cid => nextSet.delete(cid));
                                        } else {
                                          nextSet.add(parentId);
                                          childIds.forEach(cid => nextSet.add(cid));
                                        }
                                        setActiveTools(nextSet);
                                        saveActiveResources(nextSet, activeKnowledge, activeSkills);
                                      };

                                      if (isParent) {
                                        return (
                                          <div key={item.id} className="space-y-0.5">
                                            <div
                                              draggable
                                              onDragStart={(e) => handleDragStart(e, item.id)}
                                              onClick={handleToolToggle}
                                              className={`group/item flex items-start gap-1 p-1.5 rounded-md border transition-all cursor-pointer select-none ${
                                                isParentFullyActive
                                                  ? 'bg-primary/[0.04] border-primary/35 text-on-surface shadow-sm font-medium'
                                                  : isParentActive
                                                  ? 'bg-primary/[0.02] border-primary/15 text-on-surface/85 shadow-sm'
                                                  : 'bg-transparent border-outline/5 text-on-surface/50 opacity-60 hover:opacity-100 hover:border-outline/20 hover:bg-on-surface/[0.01]'
                                              }`}
                                            >
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  const next = new Set(expandedTools);
                                                  if (isExpanded) next.delete(item.id); else next.add(item.id);
                                                  setExpandedTools(next);
                                                }}
                                                className="p-0.5 rounded hover:bg-on-surface/5 text-on-surface/40 hover:text-on-surface transition-colors cursor-pointer shrink-0 mt-0.5"
                                              >
                                                <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${isExpanded ? 'rotate-0' : '-rotate-90'}`} />
                                              </button>
                                              <div className="min-w-0 flex-1 text-left">
                                                <span className={`text-[11px] font-bold leading-tight ${isParentActive ? 'text-on-surface' : 'text-on-surface/50'}`}>
                                                  {item.name}
                                                </span>
                                                {item.description && (
                                                  <div className={`text-[8.5px] leading-tight mt-px ${isParentActive ? 'text-on-surface/40' : 'text-on-surface/25'}`}>
                                                    {item.description}
                                                  </div>
                                                )}
                                              </div>
                                              <div className="shrink-0 flex items-center justify-center mt-[5px]">
                                                <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-all duration-155 ${
                                                  isParentActive ? 'border-on-surface/50 bg-on-surface/5' : 'border-on-surface/20 bg-transparent'
                                                }`}>
                                                  {isParentActive && (
                                                    <svg className="w-2.5 h-2.5 text-on-surface shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round">
                                                      <path d="M2.5 6.5L5 9L10 3.5" />
                                                    </svg>
                                                  )}
                                                </div>
                                              </div>
                                            </div>

                                            {isExpanded && (
                                              <div className="ml-3 space-y-0.5 border-l border-dashed border-outline/10 pl-2">
                                                {(item.children || []).map((child: any) => (
                                                  <div
                                                    key={child.id}
                                                    draggable
                                                    onDragStart={(e) => handleDragStart(e, child.id)}
                                                    onClick={() => {
                                                      if (type !== 'tools') return;
                                                      const nextSet = new Set(activeTools);
                                                      if (nextSet.has(child.id)) {
                                                        nextSet.delete(child.id);
                                                      } else {
                                                        nextSet.add(child.id);
                                                      }
                                                      setActiveTools(nextSet);
                                                      saveActiveResources(nextSet, activeKnowledge, activeSkills);
                                                    }}
                                                    className={`group/item flex items-center gap-2 p-1 rounded-md border transition-all cursor-pointer select-none ${
                                                      activeSet.has(child.id)
                                                        ? 'bg-primary/[0.03] border-primary/20 text-on-surface'
                                                        : 'bg-transparent border-transparent text-on-surface/40 hover:text-on-surface/70'
                                                    }`}
                                                  >
                                                    <div className="min-w-0 flex-1 text-left">
                                                      <span className={`text-[10px] font-medium ${activeSet.has(child.id) ? 'text-on-surface/80' : 'text-on-surface/40'}`}>
                                                        {child.name}
                                                        <span className="font-normal text-[8.5px] text-on-surface/30 ml-1">
                                                          ({child.description ? child.description.split(/[，。]/)[0] : ""})
                                                        </span>
                                                      </span>
                                                    </div>
                                                    <div className="shrink-0 flex items-center justify-center">
                                                      <div className={`w-3 h-3 rounded border flex items-center justify-center ${
                                                        activeSet.has(child.id) ? 'border-on-surface/40 bg-on-surface/5' : 'border-on-surface/15 bg-transparent'
                                                      }`}>
                                                        {activeSet.has(child.id) && (
                                                          <svg className="w-2 h-2 text-on-surface/60 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round">
                                                            <path d="M2.5 6.5L5 9L10 3.5" />
                                                          </svg>
                                                        )}
                                                      </div>
                                                    </div>
                                                  </div>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        );
                                      }

                                      const isChecked = activeSet.has(item.id);
                                      return (
                                        <div key={item.id} draggable onDragStart={(e) => handleDragStart(e, item.id)} onClick={() => toggleItemSelection(type, item.id)}
                                          className={`group/item flex items-start gap-2 p-1.5 rounded-md border transition-all cursor-grab active:cursor-grabbing select-none ${
                                            isChecked
                                              ? 'bg-primary/[0.04] border-primary/35 text-on-surface shadow-sm font-medium'
                                              : 'bg-transparent border-outline/5 text-on-surface/50 opacity-60 hover:opacity-100 hover:border-outline/20 hover:bg-on-surface/[0.01]'
                                          }`}
                                        >
                                          <div className="min-w-0 flex-1 text-left">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                              <span className={`text-[11px] font-bold truncate leading-tight ${isChecked ? 'text-on-surface' : 'text-on-surface/50'}`}>
                                                {item.name}
                                                <span className="font-normal text-[9.5px] text-on-surface/35 ml-1.5">
                                                  ({item.description ? item.description.split(/[，。]/)[0] : "无用处"})
                                                </span>
                                              </span>
                                            </div>
                                          </div>
                                          <div className="shrink-0 flex items-center justify-center mt-0">
                                            <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-all duration-155 ${
                                              isChecked ? 'border-on-surface/50 bg-on-surface/5' : 'border-on-surface/20 bg-transparent'
                                            }`}>
                                              {isChecked && (
                                                <svg className="w-2.5 h-2.5 text-on-surface shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="0.75" strokeLinecap="round" strokeLinejoin="round">
                                                  <path d="M2.5 6.5L5 9L10 3.5" />
                                                </svg>
                                              )}
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Bottom resize handle (高度) */}
                        <div onMouseDown={(e) => { e.preventDefault(); isResizingPopover.current = true; popoverResizeStart.current = { y: e.clientY, h: popoverHeight, x: e.clientX, w: popoverWidth, dir: 'height' }; }}
                          className="h-2 shrink-0 cursor-ns-resize border-t border-outline/20 bg-surface/50 hover:bg-primary/15 transition-colors"
                          title="拖动调整高度"
                        />
                        {/* 左侧宽度拖拽手柄 */}
                        <div onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); isResizingPopover.current = true; popoverResizeStart.current = { y: e.clientY, h: popoverHeight, x: e.clientX, w: popoverWidth, dir: 'width-left' }; }}
                          className="group absolute top-0 left-0 bottom-0 w-2 cursor-ew-resize z-10 hover:bg-primary/15 transition-colors flex items-center justify-center"
                          title="拖动调整宽度"
                        >
                          <GripVertical className="w-2.5 h-3.5 text-primary opacity-0 group-hover:opacity-90 transition-opacity pointer-events-none" />
                        </div>
                        {/* 右侧宽度拖拽手柄 */}
                        <div onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); isResizingPopover.current = true; popoverResizeStart.current = { y: e.clientY, h: popoverHeight, x: e.clientX, w: popoverWidth, dir: 'width' }; }}
                          className="group absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize z-10 hover:bg-primary/15 transition-colors flex items-center justify-center"
                          title="拖动调整宽度"
                        >
                          <GripVertical className="w-2.5 h-3.5 text-primary opacity-0 group-hover:opacity-90 transition-opacity pointer-events-none" />
                        </div>
                      </div>
                    </>
                  );
                })()}
                </div>
                {idx < arr.length - 1 && (
                  <div className="w-px h-4 bg-primary/10 shrink-0" />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Input Area */}
      <div className="p-3 border-t border-outline bg-surface shrink-0">
        <div className="max-w-5xl lg:max-w-[94%] xl:max-w-[90%] mx-auto w-full px-4 md:px-6">
          <div className="bg-bg rounded-lg border border-outline focus-within:border-primary/50 transition-colors p-2 flex flex-col gap-2">
          {pendingAttachment && (
            <div className="bg-surface border border-outline rounded-md overflow-hidden transition-all duration-200">
              <div className="flex items-center justify-between p-2 bg-surface-bright/40">
                <div className="flex items-center gap-1.5 text-[10.5px] font-sans text-on-surface/90 min-w-0">
                  <FileCode className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="truncate max-w-[180px] font-bold text-on-surface">{pendingAttachment.fileName}</span>
                  <span className="text-[9px] text-on-surface/40 font-mono shrink-0">({pendingAttachment.text.split('\n').length} 行)</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button 
                    onClick={() => setIsPendingAttachmentExpanded(!isPendingAttachmentExpanded)}
                    className="p-1 rounded hover:bg-neutral-500/10 text-on-surface/60 hover:text-primary transition-colors cursor-pointer"
                    title={isPendingAttachmentExpanded ? "折叠预览" : "展开预览"}
                  >
                    {isPendingAttachmentExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                  <button 
                    onClick={() => setPendingAttachment(null)}
                    className="p-1 rounded hover:bg-red-500/15 text-on-surface/60 hover:text-red-400 transition-colors cursor-pointer"
                    title="移除附件"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
              {isPendingAttachmentExpanded && (
                <div className="max-h-32 overflow-y-auto border-t border-outline/25 p-2 font-mono text-[9px] text-on-surface/85 bg-bg/40 whitespace-pre select-text scrollbar-thin">
                  {pendingAttachment.text}
                </div>
              )}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                handleSend();
              }
            }}
            placeholder="请输入您的需求... (Ctrl + Enter 发送)"
            className="bg-transparent text-xs text-on-surface placeholder-on-surface/30 select-text outline-none resize-none h-14 w-full p-1"
          />
          
          <div className="flex items-center justify-between pt-1 border-t border-outline/30">
            {/* Conversation mode select dropdown */}
            <div className="relative" id="chat-mode-selection-dropdown">
              <motion.button 
                onClick={() => setShowModeDropdown(!showModeDropdown)}
                whileHover={{ y: -1 }}
                whileTap={{ y: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className="flex items-center gap-1.5 text-[10px] text-on-surface/85 bg-surface-bright hover:bg-bg border border-outline px-2.5 py-1 rounded cursor-pointer hover:text-on-surface transition-all font-sans font-bold shadow select-none"
                style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
              >
                {permissionMode === 'normal' && <NormalIcon className="w-3.5 h-3.5" />}
                {permissionMode === 'performance' && <PerformanceIcon className="w-3.5 h-3.5" />}
                {permissionMode === 'expert' && <ExpertIcon className="w-3.5 h-3.5" />}
                {permissionMode === 'ultimate' && <UltimateIcon className="w-3.5 h-3.5" />}
                <span>
                  {permissionMode === 'normal' ? '普通模式 (安全)' :
                   permissionMode === 'performance' ? '性能模式 (半自动)' :
                   permissionMode === 'expert' ? '专家模式 (全自动)' : '极致模式 (全自动)'}
                </span>
                <ChevronDown className={`w-2.5 h-2.5 opacity-60 transition-transform duration-200 ${showModeDropdown ? 'rotate-180' : ''}`} />
              </motion.button>

              <AnimatePresence>
                {showModeDropdown && (
                  <>
                    <div 
                      className="fixed inset-0 z-40 cursor-default" 
                      onClick={() => setShowModeDropdown(false)}
                    />
                    <motion.div 
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 6 }}
                      transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                      style={{ 
                        transformOrigin: "bottom left",
                        backfaceVisibility: "hidden",
                        WebkitFontSmoothing: "subpixel-antialiased"
                      }}
                      className="absolute left-0 bottom-full mb-1.5 w-[230px] bg-surface/98 backdrop-blur-md border border-outline/35 rounded-lg shadow-2xl p-1.5 flex flex-col font-sans z-50 capitalize-none text-left"
                    >
                      <span className="text-[9px] text-primary/70 px-2 py-1 font-semibold border-b border-outline/25 mb-1 tracking-wider uppercase select-none">
                        运行资源模式
                      </span>

                      {/* Normal Mode Option */}
                      <motion.button
                        onClick={() => {
                          setPermissionMode?.('normal');
                          setShowModeDropdown(false);
                        }}
                        whileHover={{ x: 2 }}
                        transition={{ type: "spring", stiffness: 450, damping: 25 }}
                        className={`flex flex-col gap-0.5 p-2 rounded text-left transition-colors cursor-pointer select-none group ${
                          permissionMode === 'normal' ? 'bg-emerald-500/10 border border-emerald-500/25 text-on-surface' : 'hover:bg-surface-bright text-on-surface/80 hover:text-on-surface'
                        }`}
                        style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
                      >
                        <div className="flex items-center justify-between text-[10.5px] font-bold">
                          <div className="flex items-center gap-1.5 text-emerald-400 font-sans group-hover:text-emerald-300 transition-colors">
                            <NormalIcon className="w-4 h-4" />
                            <span>普通模式 (安全)</span>
                          </div>
                          {permissionMode === 'normal' && <Check className="w-3 h-3 text-emerald-400" />}
                        </div>
                        <p className="text-[9px] leading-relaxed text-on-surface/50 font-medium whitespace-normal font-sans group-hover:text-on-surface/70 transition-colors">
                          自动识别并绕过风险命令，守护代码与环境安全。
                        </p>
                      </motion.button>

                      {/* Performance Mode Option */}
                      <motion.button
                        onClick={() => {
                          setPermissionMode?.('performance');
                          setShowModeDropdown(false);
                        }}
                        whileHover={{ x: 2 }}
                        transition={{ type: "spring", stiffness: 450, damping: 25 }}
                        className={`flex flex-col gap-0.5 p-2 rounded text-left transition-colors cursor-pointer select-none group ${
                          permissionMode === 'performance' ? 'bg-purple-500/10 border border-purple-500/25 text-on-surface' : 'hover:bg-surface-bright text-on-surface/80 hover:text-on-surface'
                        }`}
                        style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
                      >
                        <div className="flex items-center justify-between text-[10.5px] font-bold">
                          <div className="flex items-center gap-1.5 text-purple-400 font-sans group-hover:text-purple-300 transition-colors">
                            <PerformanceIcon className="w-4 h-4" />
                            <span>性能模式 (半自动)</span>
                          </div>
                          {permissionMode === 'performance' && <Check className="w-3 h-3 text-purple-400" />}
                        </div>
                        <p className="text-[9px] leading-relaxed text-on-surface/50 font-medium whitespace-normal font-sans group-hover:text-on-surface/70 transition-colors">
                          自主加载各项基础工具逻辑，支持多模型智能混合。
                        </p>
                      </motion.button>

                      {/* Expert Mode Option */}
                      <motion.button
                        onClick={() => {
                          setPermissionMode?.('expert');
                          setShowModeDropdown(false);
                        }}
                        whileHover={{ x: 2 }}
                        transition={{ type: "spring", stiffness: 450, damping: 25 }}
                        className={`flex flex-col gap-0.5 p-2 rounded text-left transition-colors cursor-pointer select-none group ${
                          permissionMode === 'expert' ? 'bg-amber-500/10 border border-amber-500/25 text-on-surface' : 'hover:bg-surface-bright text-on-surface/80 hover:text-on-surface'
                        }`}
                        style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
                      >
                        <div className="flex items-center justify-between text-[10.5px] font-bold">
                          <div className="flex items-center gap-1.5 text-amber-500 font-sans group-hover:text-amber-400 transition-colors">
                            <ExpertIcon className="w-4 h-4" />
                            <span>专家模式 (全自动)</span>
                          </div>
                          {permissionMode === 'expert' && <Check className="w-3 h-3 text-amber-500" />}
                        </div>
                        <p className="text-[9px] leading-relaxed text-on-surface/50 font-medium whitespace-normal font-sans group-hover:text-on-surface/70 transition-colors">
                          深度专家级 resource 调度，多模型高频协同攻坚复杂任务。
                        </p>
                      </motion.button>

                      {/* Ultimate Mode Option */}
                      <motion.button
                        onClick={() => {
                          setPermissionMode?.('ultimate');
                          setShowModeDropdown(false);
                        }}
                        whileHover={{ x: 2 }}
                        transition={{ type: "spring", stiffness: 450, damping: 25 }}
                        className={`flex flex-col gap-0.5 p-2 rounded text-left transition-colors cursor-pointer select-none group ${
                          permissionMode === 'ultimate' ? 'bg-red-500/10 border border-red-500/25 text-on-surface' : 'hover:bg-surface-bright text-on-surface/80 hover:text-on-surface'
                        }`}
                        style={{ backfaceVisibility: "hidden", WebkitFontSmoothing: "subpixel-antialiased" }}
                      >
                        <div className="flex items-center justify-between text-[10.5px] font-bold">
                          <div className="flex items-center gap-1.5 text-red-500 font-sans group-hover:text-red-400 transition-colors">
                            <UltimateIcon className="w-4 h-4" />
                            <span>极致模式 (全自动)</span>
                          </div>
                          {permissionMode === 'ultimate' && <Check className="w-3 h-3 text-red-500" />}
                        </div>
                        <p className="text-[9px] leading-relaxed text-on-surface/50 font-medium whitespace-normal font-sans group-hover:text-on-surface/70 transition-colors">
                          最大化释放算力，无中断调度全部工具加速实现诉求。
                        </p>
                      </motion.button>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

            {/* Submit Send Button */}
            <button
              onClick={handleSend}
              className="bg-[#2563eb] hover:bg-blue-500 text-white rounded px-3 py-1 flex items-center gap-1 text-[10px] font-semibold tracking-wide active:scale-95 transition-all cursor-pointer shadow-md"
            >
              <span>发送</span>
              <Send className="w-3 h-3" />
            </button>
          </div>
        </div>
        </div>
      </div>

      {/* Code Documentation Generator Modal */}
      <AnimatePresence>
        {isDocsModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsDocsModalOpen(false)}
              className="absolute inset-0 bg-transparent"
            />
            
            {/* Real Backdrop Layer for blur and click-out */}
            <div 
              className="fixed inset-0 bg-black/75 backdrop-blur-sm z-40" 
              onClick={() => setIsDocsModalOpen(false)}
            />

            {/* Modal Body */}
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ type: "spring", stiffness: 360, damping: 28 }}
              className="relative w-full max-w-2xl bg-surface border border-outline rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.15)] overflow-hidden flex flex-col max-h-[85vh] font-sans z-50 text-left"
            >
              {/* Header */}
              <div className="p-4 border-b border-outline/40 bg-bg/40 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-on-surface">智能代码文档生成助手</h3>
                    <p className="text-[10px] text-on-surface/50">支持生成标准 JSDoc 或 Markdown 格式注释文档并一键注入头部</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-1.5 ml-auto mr-1" />

                <button
                  onClick={() => setIsDocsModalOpen(false)}
                  className="p-1 hover:bg-surface-bright rounded text-on-surface/40 hover:text-primary transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Content */}
              <div className="p-5 flex-1 overflow-y-auto space-y-4">
                {/* Helper Guide Explanation Section */}
                <AnimatePresence>
                  {showHelperGuide && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="p-4 bg-emerald-500/5 rounded-lg border border-emerald-500/15 space-y-2.5 text-xs text-left mb-2">
                        <div className="flex items-center gap-2 text-emerald-400 font-bold">
                          <HelpCircle className="w-4 h-4 shrink-0 text-[#ffde82]" />
                          <span>这个功能的作用是什么？（Code Documentation Helper）</span>
                        </div>
                        <div className="text-on-surface/80 space-y-2 leading-relaxed text-[11px]">
                          <p>
                            <strong>1. 智能精要解析</strong>：借助内核集成的 Gemini 大模型能力，高敏感度捕捉您框选的主体代码的传参、业务边界、执行序列，并完成架构级梳理。
                          </p>
                          <p>
                            <strong>2. 双规定制机制</strong>：
                          </p>
                          <ul className="list-disc list-inside pl-3 space-y-1 text-on-surface/70">
                            <li><strong>JSDoc 规格</strong>：完美遵循开发标准，输出包含 <code className="text-[#ffde82] bg-white/5 px-1 py-0.5 rounded font-mono">@param</code> / <code className="text-[#ffde82] bg-white/5 px-1 py-0.5 rounded font-mono">@returns</code> 的方法块级多行原生注释。</li>
                            <li><strong>Markdown 规格</strong>：提供清晰的代码结构拆解、业务流走向分析与极端边界说明，最适合用于研发 Wiki、设计白皮书的团队归档。</li>
                          </ul>
                          <p>
                            <strong>3. 一键无缝集成 / 卓越导出</strong>：
                          </p>
                          <ul className="list-disc list-inside pl-3 space-y-1 text-on-surface/70">
                            <li><strong>头部注入</strong>：点击后全自动将格式化的文档内容添加至该文件顶部第1行，消除繁杂的手动选中复制流程。</li>
                            <li><strong>自主导出</strong>：支持生成并下载对应的文档文件包，免去粘连错误。</li>
                          </ul>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Active Context Selection File info */}
                <div className="p-3 bg-bg/40 rounded-lg border border-outline flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-on-surface/80">
                    <FileCode className="w-4 h-4 text-primary" />
                    <span className="font-semibold text-on-surface">当前代码上下文:</span>
                    <span className="font-mono text-emerald-400 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded text-[10.5px]">
                      {selectedFileName || '未选择文件'}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      // Re-request selected text from editor
                      window.dispatchEvent(new CustomEvent('soloforge-request-selected-text'));
                    }}
                    className="text-[10px] text-primary hover:underline flex items-center gap-1 cursor-pointer font-bold"
                  >
                    <Clock className="w-3 h-3" />
                    <span>重试抓取选区</span>
                  </button>
                </div>

                {/* Selected Code display or warning */}
                <div className="space-y-1.5 text-left">
                  <div className="flex justify-between items-center text-[10px] font-bold text-on-surface/40 uppercase tracking-wider">
                    <span>欲文档化的内容段 (可在此直接任意编辑、删减、增加内容或填入文本)</span>
                    {selectedCode ? (
                      isWholeFile ? (
                        <span className="text-[9px] text-[#34d399] font-bold bg-[#34d399]/10 border border-[#34d399]/20 px-1.5 py-0.5 rounded">
                          已捕获整份文件
                        </span>
                      ) : (
                        <span className="text-[9px] text-[#ffde82] font-bold bg-[#ffde82]/10 border border-[#ffde82]/20 px-1.5 py-0.5 rounded">
                          已捕获高亮选区
                        </span>
                      )
                    ) : (
                      <span className="text-[9px] text-red-400 font-bold bg-red-400/10 border border-red-400/20 px-1.5 py-0.5 rounded">
                        待自主输入
                      </span>
                    )}
                  </div>

                  <div className="relative group rounded-md border border-outline focus-within:border-primary bg-bg/50 overflow-hidden transition-all flex flex-col">
                    <textarea
                      value={selectedCode}
                      onChange={(e) => setSelectedCode(e.target.value)}
                      placeholder="直接在此处贴入、编写、删除、修改任何需要文档化的代码、汉字备注或其它内容。也可以双击或划选编辑器中的代码自动实时抓取..."
                      className="w-full h-40 p-3 bg-transparent text-[11px] font-mono text-on-surface placeholder-on-surface/30 outline-none resize-y select-text leading-relaxed border-none focus:ring-0 active:ring-0 focus:outline-none"
                    />
                    
                    {/* Character / Line Counters */}
                    <div className="flex items-center justify-between px-3 py-1.5 bg-surface-bright/50 border-t border-outline/30 text-[10px] font-mono text-on-surface/50 select-none">
                      <div className="flex items-center gap-3">
                        <span>行数: <strong className="text-on-surface">{selectedCode ? selectedCode.split('\n').length : 0}</strong></span>
                        <span>字符数: <strong className="text-on-surface">{selectedCode.length}</strong></span>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        {selectedCode && (
                          <button
                            onClick={() => setSelectedCode('')}
                            className="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded border border-red-500/20 hover:border-red-500/40 font-semibold cursor-pointer transition-colors text-[9px]"
                            title="一键清空"
                          >
                            清空内容
                          </button>
                        )}
                        <span className="text-[9px] text-emerald-500/70 font-semibold bg-emerald-500/5 border border-emerald-500/10 px-1.5 rounded">
                          支持自定义输入与中英文混排
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Formats and action triggers */}
                <div className="flex items-center justify-between pt-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-on-surface/80">目标格式规格:</span>
                    <div className="flex bg-bg/60 p-0.5 rounded border border-outline/30 text-[10.5px]">
                      <button
                        onClick={() => setGeneratedDocFormat('jsdoc')}
                        className={`px-3 py-1 rounded font-bold transition-all cursor-pointer ${
                          generatedDocFormat === 'jsdoc' 
                            ? 'bg-primary text-bg' 
                            : 'text-on-surface/65 hover:text-primary'
                        }`}
                      >
                        JSDoc 注释规格
                      </button>
                      <button
                        onClick={() => setGeneratedDocFormat('markdown')}
                        className={`px-3 py-1 rounded font-bold transition-all cursor-pointer ${
                          generatedDocFormat === 'markdown' 
                            ? 'bg-primary text-bg' 
                            : 'text-on-surface/65 hover:text-primary'
                        }`}
                      >
                        Markdown 解析规格
                      </button>
                    </div>
                  </div>

                  <button
                    onClick={() => handleGenerateDocs(generatedDocFormat)}
                    disabled={isGeneratingDocs || !selectedCode.trim()}
                    className="flex items-center gap-1.5 bg-[#2563eb] hover:bg-blue-500 text-white rounded-lg px-4 py-2 text-xs font-bold active:scale-95 transition-all cursor-pointer disabled:opacity-40 disabled:hover:bg-[#2563eb]"
                  >
                    {isGeneratingDocs ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>智算生成中...</span>
                      </>
                    ) : (
                      <>
                        <Brain className="w-3.5 h-3.5 text-[#ffde82]" />
                        <span>启动大模型智算生成</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Generation output / Errors */}
                {errorMsg && (
                  <div className="p-3 bg-red-500/10 border border-red-500/25 rounded-md text-red-400 text-[11px] font-semibold leading-relaxed text-left">
                    ⚠️ {errorMsg}
                  </div>
                )}

                {/* Result area */}
                {generatedContent && (
                  <div className="space-y-2 animate-fadeIn select-text text-left">
                    <div className="flex items-center justify-between text-[10px] font-bold text-on-surface/40 uppercase tracking-wider">
                      <span>生成成果详情预览</span>
                      <span className="text-[9px] text-emerald-400 font-mono">GENERATE EXCELLENT STATUS: OK</span>
                    </div>

                    <div className="relative rounded-md border border-outline bg-surface p-3 shadow-lg max-h-[200px] overflow-y-auto font-mono text-[11.5px] text-on-surface whitespace-pre-wrap select-text leading-relaxed text-left">
                      {generatedContent}
                    </div>

                    {/* Footer operations (copy, export & insert) */}
                    <div className="grid grid-cols-3 gap-2.5 pt-2 select-none">
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(generatedContent);
                          setCopiedDoc(true);
                          setTimeout(() => setCopiedDoc(false), 2000);
                        }}
                        className="flex items-center justify-center gap-1 py-2 px-1 rounded-lg border border-outline/40 hover:bg-surface-bright text-xs font-semibold text-on-surface/90 hover:text-primary transition-colors cursor-pointer"
                      >
                        {copiedDoc ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
                            <span>已复制</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 text-on-surface/50 shrink-0" />
                            <span>复制代码</span>
                          </>
                        )}
                      </button>

                      <button
                        onClick={handleExportDoc}
                        className="flex items-center justify-center gap-1 py-2 px-1 rounded-lg border border-outline/40 hover:bg-surface-bright text-xs font-semibold text-on-surface/90 hover:text-primary transition-colors cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5 text-on-surface/50 shrink-0" />
                        <span>导出文档</span>
                      </button>

                      <button
                        onClick={handleInsertToCodeHead}
                        className="flex items-center justify-center gap-1 py-2 px-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 font-bold text-xs transition-all cursor-pointer shadow-[0_2px_10px_rgba(16,185,129,0.15)]"
                      >
                        <CheckCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span>一键应用头部</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>



      {/* Integrated Terminal Panel Stacked */}
      <TerminalPanel permissionMode={permissionMode} />
    </div>
  );
}
