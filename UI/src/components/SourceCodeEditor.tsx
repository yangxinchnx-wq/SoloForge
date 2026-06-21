import React, { useState, useRef, useEffect, ReactNode } from 'react';
import { 
  FileCode, 
  Check, 
  Copy, 
  ArrowUpRight, 
  Search, 
  X, 
  ChevronUp, 
  ChevronDown, 
  Clipboard, 
  Scissors, 
  Trash2, 
  FolderOpen, 
  MessageSquare,
  Replace,
  AlertTriangle,
  AlertCircle,
  Info
} from 'lucide-react';

interface SourceCodeEditorProps {
  selectedFile: string;
  editorContent: string;
  setEditorContent: (content: string) => void;
  isPopoutView?: boolean;
}

// Stably preserve application-session local clipboard for restricted container iframe sandboxes
let localClipboard = '';

interface Diagnostic {
  lineNum: number;
  text: string;
  word: string;
  severity: 'error' | 'warning' | 'info';
}

const formatCode = (content: string, ext: string): string => {
  if (!content) return '';
  const trimmed = content.trim();
  
  if (ext === 'json') {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch (e) {
      return content;
    }
  }

  // General curly-brace indentation formatter for JS/TS/TSX/JSX/CSS/HTML
  const lines = trimmed.split('\n');
  const formattedLines: string[] = [];
  let currentIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (line === '') {
      formattedLines.push('');
      continue;
    }

    let openCount = 0;
    let closeCount = 0;
    let inString: string | null = null;
    let isEscaped = false;

    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === '\\') {
        isEscaped = true;
        continue;
      }
      if (inString) {
        if (char === inString) {
          inString = null;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        inString = char;
        continue;
      }
      if (char === '/' && line[c + 1] === '/') {
        break;
      }

      if (char === '{' || char === '[' || char === '(') {
        openCount++;
      } else if (char === '}' || char === ']' || char === ')') {
        closeCount++;
      }
    }

    const startsWithClose = /^[}\]\)]/.test(line);
    let lineIndent = currentIndent;

    if (startsWithClose) {
      lineIndent = Math.max(0, currentIndent - 1);
    }

    currentIndent = Math.max(0, currentIndent + openCount - closeCount);
    formattedLines.push('  '.repeat(lineIndent) + line);
  }

  const cleaned: string[] = [];
  let consecutiveEmpty = 0;
  for (let line of formattedLines) {
    if (line.trim() === '') {
      consecutiveEmpty++;
    } else {
      consecutiveEmpty = 0;
    }
    if (consecutiveEmpty <= 1) {
      cleaned.push(line);
    }
  }

  return cleaned.join('\n');
};

export default function SourceCodeEditor({
  selectedFile,
  editorContent,
  setEditorContent,
  isPopoutView = false,
}: SourceCodeEditorProps) {
  const [copied, setCopied] = useState(false);
  const getFileExtension = () => {
    return selectedFile.split('.').pop() || '';
  };

  const getLanguageDisplayName = () => {
    const ext = getFileExtension().toLowerCase();
    switch (ext) {
      case 'py': return 'Python';
      case 'js': return 'JavaScript';
      case 'ts': return 'TypeScript';
      case 'tsx': return 'TypeScript React';
      case 'jsx': return 'JavaScript React';
      case 'c': return 'C';
      case 'cpp': case 'cc': case 'cxx': case 'h': case 'hpp': return 'C++';
      case 'cs': return 'C#';
      case 'java': return 'Java';
      case 'kt': case 'kts': return 'Kotlin';
      case 'html': case 'htm': return 'HTML';
      case 'css': return 'CSS';
      case 'json': return 'JSON';
      case 'md': return 'Markdown';
      case 'go': return 'Go';
      case 'rs': return 'Rust';
      case 'sh': case 'bash': return 'Shell';
      case 'swift': return 'Swift';
      case 'sql': return 'SQL';
      case 'yaml': case 'yml': return 'YAML';
      case 'txt': return 'TXT';
      default: return ext ? ext.toUpperCase() : 'TXT';
    }
  };

  const getFileDisplayName = () => {
    const parts = selectedFile.split('/');
    return parts[parts.length - 1];
  };
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  // Search & Replace Panel State
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean } | null>(null);

  // Collapsible diagnostics state
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // Static Real-time Code Analyzer Engine
  const diagnostics = React.useMemo<Diagnostic[]>(() => {
    const list: Diagnostic[] = [];
    const safeContentLocal = editorContent || '';
    if (!safeContentLocal) return list;

    const ext = getFileExtension().toLowerCase();
    const lines = safeContentLocal.split('\n');

    // Mismatched bracket stack tracker
    const bracketStack: { char: string; line: number; col: number }[] = [];

    // Analyze line-by-line
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const lineText = lines[i];
      const trimmed = lineText.trim();

      // Skip comment blocks
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('<!--') || trimmed.startsWith('#')) {
        if (trimmed.includes('TODO:') || trimmed.includes('TODO ')) {
          list.push({
            lineNum,
            text: '待办事项 (TODO): 仍有未尽事宜、缺省逻辑或可优化块需开发',
            word: 'TODO',
            severity: 'info'
          });
        }
        if (trimmed.includes('FIXME:') || trimmed.includes('FIXME ')) {
          list.push({
            lineNum,
            text: '修复标记 (FIXME): 该行可能隐藏着已确认的异常行为，建议优先重新审核',
            word: 'FIXME',
            severity: 'warning'
          });
        }
        continue;
      }

      // Check console.log
      if (trimmed.includes('console.log')) {
        list.push({
          lineNum,
          text: '潜在调试残留: 生产就绪型源码建议删除多余的 console.log(...) 测试语句',
          word: 'console.log',
          severity: 'info'
        });
      }

      // Check eval()
      if (trimmed.includes('eval(')) {
        list.push({
          lineNum,
          text: '高风险安全警告: 拒绝使用极其危险的 eval(...) 函数。不仅执行效率极慢，还会导致代码注入漏洞',
          word: 'eval(',
          severity: 'error'
        });
      }

      // Bracket mismatch scanning helper per character
      let inQuote: string | null = null;
      let escapedQuote = false;
      let singleQuoteCount = 0;
      let doubleQuoteCount = 0;

      for (let col = 0; col < lineText.length; col++) {
        const char = lineText[col];
        if (escapedQuote) {
          escapedQuote = false;
          continue;
        }
        if (char === '\\') {
          escapedQuote = true;
          continue;
        }

        if (inQuote) {
          if (char === inQuote) {
            inQuote = null;
          }
          continue;
        }

        if (char === '"' || char === "'" || char === '`') {
          inQuote = char;
          if (char === "'") singleQuoteCount++;
          if (char === '"') doubleQuoteCount++;
          continue;
        }

        // Bracket pushing
        if (char === '{' || char === '[' || char === '(') {
          bracketStack.push({ char, line: lineNum, col: col + 1 });
        } else if (char === '}' || char === ']' || char === ')') {
          const last = bracketStack.pop();
          if (!last) {
            list.push({
              lineNum,
              text: `语法异常: 行内出现多余的、或无对应左括号的右括号 '${char}'`,
              word: char,
              severity: 'error'
            });
          } else {
            const isMatch = 
              (last.char === '{' && char === '}') ||
              (last.char === '[' && char === ']') ||
              (last.char === '(' && char === ')');
            if (!isMatch) {
              list.push({
                lineNum,
                text: `语法嵌套异常: 括号不匹配。此处检测到 '${char}'，但它与第 ${last.line} 行的 '${last.char}' 正确嵌套格式相背离`,
                word: char,
                severity: 'error'
              });
              // Put back to prevent excess match errors cascading
              bracketStack.push(last);
            }
          }
        }
      }

      // Match unbalanced unescaped quotes per line
      if (singleQuoteCount % 2 !== 0 && !trimmed.endsWith('`') && !trimmed.startsWith('`')) {
        list.push({
          lineNum,
          text: '语法提示: 行内疑似存在未正常闭合的单引号 \'',
          word: "'",
          severity: 'warning'
        });
      }
      if (doubleQuoteCount % 2 !== 0 && !trimmed.endsWith('`') && !trimmed.startsWith('`')) {
        list.push({
          lineNum,
          text: '语法提示: 行内疑似存在未正常闭合的双引号 "',
          word: '"',
          severity: 'warning'
        });
      }

      // Soft rules checking loose equality
      if (trimmed.includes(' == ') && !trimmed.includes(' === ')) {
        list.push({
          lineNum,
          text: '代码味道警告: 请使用高严苛性 === 运算符进行比对，以规避非安全的弱类型自动转型 == 比较',
          word: '==',
          severity: 'warning'
        });
      }
      if (trimmed.includes(' != ') && !trimmed.includes(' !== ')) {
        list.push({
          lineNum,
          text: '代码味道警告: 请使用高严苛性 !== 运算符进行比对，以规避非安全的弱类型自动转型 != 比较',
          word: '!=',
          severity: 'warning'
        });
      }

      // Empty if statement condition checks
      if (trimmed.includes('if ()') || trimmed.includes('if()')) {
        list.push({
          lineNum,
          text: '逻辑空洞错误: if 条件控制块内容缺失，括号()中填入了空表达式，可能引发静态诊断失效',
          word: 'if ()',
          severity: 'error'
        });
      }
    }

    // Unclosed brackets left
    while (bracketStack.length > 0) {
      const top = bracketStack.pop();
      if (top) {
        if (list.filter(d => d.text.includes('未妥善闭合')).length < 3) {
          list.push({
            lineNum: top.line,
            text: `嵌套异常: 括号 '${top.char}' 未妥善闭合，缺失相应的右半边闭合标识`,
            word: top.char,
            severity: 'error'
          });
        }
      }
    }

    // JSON parsing check
    if (ext === 'json') {
      try {
        JSON.parse(safeContentLocal);
      } catch (e: any) {
        const msg = e.message || '';
        let errLine = 1;
        const lineMatch = msg.match(/line (\d+)/i) || msg.match(/position (\d+)/i);
        if (lineMatch) {
          errLine = parseInt(lineMatch[1]);
          if (msg.includes('position')) {
            const pos = parseInt(lineMatch[1]);
            errLine = safeContentLocal.substring(0, pos).split('\n').length;
          }
        }
        list.push({
          lineNum: errLine,
          text: `JSON 格式异常: 静态解析器判定此 JSON 文件无法正常在 V8 核心中进行序列化。错误原因: ${msg}`,
          word: '',
          severity: 'error'
        });
      }
    }

    return list.sort((a, b) => a.lineNum - b.lineNum);
  }, [editorContent, selectedFile]);

  // Jump to specific line and scroll textarea
  const jumpToLine = (lineNum: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const textVal = textarea.value;
    const lines = textVal.split('\n');
    
    let charIndex = 0;
    for (let i = 0; i < Math.min(lineNum - 1, lines.length); i++) {
      charIndex += lines[i].length + 1; // +1 is newline char
    }

    textarea.focus();
    textarea.setSelectionRange(charIndex, charIndex + (lines[lineNum - 1]?.length || 0));

    setCursorPos({
      line: lineNum,
      col: 1
    });

    // Estimate line scroll index based on line height (20px)
    const scrollTopDest = Math.max(0, (lineNum - 5) * 20);
    textarea.scrollTop = scrollTopDest;
    if (preRef.current) {
      preRef.current.scrollTop = scrollTopDest;
    }
  };

  // Format code automatically on blur/defocus by default
  const handleBlur = () => {
    const ext = getFileExtension().toLowerCase();
    const safeContentLocal = editorContent || '';
    const formatted = formatCode(safeContentLocal, ext);
    if (formatted !== safeContentLocal) {
      setEditorContent(formatted);
    }
  };

  const handleCopy = () => {
    const safeContent = editorContent || '';
    navigator.clipboard.writeText(safeContent);
    localClipboard = safeContent;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePopout = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('soloforge-open-floating-editor'));
  };

  // Synchronize scrolling of line numbers & highlight layers with code textarea
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    if (lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = target.scrollTop;
    }
    if (preRef.current) {
      preRef.current.scrollTop = target.scrollTop;
      preRef.current.scrollLeft = target.scrollLeft;
    }
  };

  const handleSelectionChange = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    const textBefore = target.value.substring(0, target.selectionStart);
    const lines = textBefore.split('\n');
    setCursorPos({
      line: lines.length,
      col: lines[lines.length - 1].length + 1
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (e.key === 'Enter') {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;

      // Extract existing indentation style
      const textBeforeCursor = value.substring(0, start);
      const linesBefore = textBeforeCursor.split('\n');
      const currentLine = linesBefore[linesBefore.length - 1];

      const indentMatch = currentLine.match(/^([ \t]*)/);
      let indent = indentMatch ? indentMatch[1] : '';

      const trimmedCurrent = currentLine.trim();
      const endsWithOpenBracket = trimmedCurrent.endsWith('{') || trimmedCurrent.endsWith('[') || trimmedCurrent.endsWith('(') || trimmedCurrent.endsWith(':');
      
      if (endsWithOpenBracket) {
        const step = indent.includes('\t') ? '\t' : '  ';
        indent += step;
      }

      e.preventDefault();

      const newValue = value.substring(0, start) + '\n' + indent + value.substring(end);
      setEditorContent(newValue);

      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 1 + indent.length;
        const updatedTextBefore = textarea.value.substring(0, textarea.selectionStart);
        const updatedLines = updatedTextBefore.split('\n');
        setCursorPos({
          line: updatedLines.length,
          col: updatedLines[updatedLines.length - 1].length + 1
        });
        if (preRef.current) {
          preRef.current.scrollTop = textarea.scrollTop;
          preRef.current.scrollLeft = textarea.scrollLeft;
        }
      }, 0);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;

      const tabInsert = '  ';
      const newValue = value.substring(0, start) + tabInsert + value.substring(end);
      setEditorContent(newValue);

      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + tabInsert.length;
        const updatedTextBefore = textarea.value.substring(0, textarea.selectionStart);
        const updatedLines = updatedTextBefore.split('\n');
        setCursorPos({
          line: updatedLines.length,
          col: updatedLines[updatedLines.length - 1].length + 1
        });
        if (preRef.current) {
          preRef.current.scrollTop = textarea.scrollTop;
          preRef.current.scrollLeft = textarea.scrollLeft;
        }
      }, 0);
    }
  };

  const safeContent = editorContent || '';
  const lines = safeContent.split('\n');
  const lineNumbers = Array.from({ length: lines.length }, (_, idx) => idx + 1);
  const relativePathSegments = selectedFile.split('/');

  // Search matches calculation
  const getMatches = (query: string, content: string) => {
    if (!query) return [];
    const matches: number[] = [];
    let index = content.toLowerCase().indexOf(query.toLowerCase());
    while (index !== -1) {
      matches.push(index);
      index = content.toLowerCase().indexOf(query.toLowerCase(), index + 1);
    }
    return matches;
  };

  const searchMatches = React.useMemo(() => {
    return getMatches(searchQuery, safeContent);
  }, [searchQuery, safeContent]);

  // Handle Match Selection and Focus Auto Scroll
  const selectMatch = (matchIdx: number) => {
    if (searchMatches.length > 0 && matchIdx >= 0 && matchIdx < searchMatches.length) {
      const start = searchMatches[matchIdx];
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(start, start + searchQuery.length);
        
        // Compute line numbers to set cursor display accurately
        const textBefore = safeContent.substring(0, start);
        const linesBefore = textBefore.split('\n');
        setCursorPos({
          line: linesBefore.length,
          col: linesBefore[linesBefore.length - 1].length + 1
        });

        // Let the preRef and pre-renderer scroll with textarea safely
        setTimeout(() => {
          if (preRef.current) {
            preRef.current.scrollTop = textarea.scrollTop;
            preRef.current.scrollLeft = textarea.scrollLeft;
          }
        }, 30);
      }
    }
  };

  // Adjust match index bounds automatically
  useEffect(() => {
    if (searchMatches.length > 0) {
      setCurrentMatchIndex(0);
      selectMatch(0);
    } else {
      setCurrentMatchIndex(-1);
    }
  }, [searchQuery]);

  const handleNextMatch = () => {
    if (searchMatches.length > 0) {
      const nextIdx = (currentMatchIndex + 1) % searchMatches.length;
      setCurrentMatchIndex(nextIdx);
      selectMatch(nextIdx);
    }
  };

  const handlePrevMatch = () => {
    if (searchMatches.length > 0) {
      const prevIdx = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
      setCurrentMatchIndex(prevIdx);
      selectMatch(prevIdx);
    }
  };

  // Replace active match
  const handleReplace = () => {
    if (searchMatches.length > 0 && currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length) {
      const start = searchMatches[currentMatchIndex];
      const newValue = safeContent.substring(0, start) + replaceQuery + safeContent.substring(start + searchQuery.length);
      setEditorContent(newValue);
      
      // Select the current match after modification
      setTimeout(() => {
        const nextMatches = getMatches(searchQuery, newValue);
        if (nextMatches.length > 0) {
          const clampedIdx = Math.min(currentMatchIndex, nextMatches.length - 1);
          setCurrentMatchIndex(clampedIdx);
          // Focus textarea and set range
          const textarea = textareaRef.current;
          if (textarea) {
            textarea.focus();
            textarea.setSelectionRange(nextMatches[clampedIdx], nextMatches[clampedIdx] + searchQuery.length);
          }
        } else {
          setCurrentMatchIndex(-1);
        }
      }, 50);
    }
  };

  // Replace all matches
  const handleReplaceAll = () => {
    if (searchQuery) {
      const regex = new RegExp(searchQuery.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
      const replaced = safeContent.replace(regex, replaceQuery);
      setEditorContent(replaced);
      setCurrentMatchIndex(-1);
      
      // Dispatch Success Toast
      const customToastEv = new CustomEvent('soloforge-toast', {
        detail: {
          message: `成功全部替换 ${searchMatches.length} 处匹配`,
          type: 'success'
        }
      });
      window.dispatchEvent(customToastEv);
    }
  };

  // Context menu operations
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    setContextMenu({ x, y, visible: true });
  };

  // Dismiss context menu automatically on global events
  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, []);

  // Keyboard shortcut listener for Ctrl+F Search
  useEffect(() => {
    const handleKeyDownGlobal = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDownGlobal);
    return () => {
      window.removeEventListener('keydown', handleKeyDownGlobal);
    };
  }, []);

  // Sync selected file code content queries requested by helper agents
  useEffect(() => {
    const handleReqText = () => {
      const textarea = textareaRef.current;
      const selectedText = textarea ? textarea.value.substring(textarea.selectionStart, textarea.selectionEnd) : '';
      window.dispatchEvent(new CustomEvent('soloforge-response-selected-text', {
        detail: {
          text: selectedText,
          fullContent: safeContent,
          fileName: selectedFile
        }
      }));
    };
    window.addEventListener('soloforge-request-selected-text', handleReqText);
    return () => {
      window.removeEventListener('soloforge-request-selected-text', handleReqText);
    };
  }, [safeContent, selectedFile]);

  // Context Menu Action callbacks
  const handleCtxCopy = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      const selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
      const textToCopy = selectedText || safeContent;
      navigator.clipboard.writeText(textToCopy);
      localClipboard = textToCopy;
      setContextMenu(null);

      const toast = new CustomEvent('soloforge-toast', {
        detail: {
          message: selectedText ? '已复制选定代码' : '已复制全部代码',
          type: 'success'
        }
      });
      window.dispatchEvent(toast);
    }
  };

  const handleCtxCut = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selectedText = textarea.value.substring(start, end);
      if (selectedText) {
        navigator.clipboard.writeText(selectedText);
        localClipboard = selectedText;
        const newValue = textarea.value.substring(0, start) + textarea.value.substring(end);
        setEditorContent(newValue);
        setContextMenu(null);

        // Retain textarea focus
        setTimeout(() => {
          textarea.focus();
          textarea.selectionStart = textarea.selectionEnd = start;
        }, 0);
      }
    }
  };

  const handleCtxPaste = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      
      const applyPaste = (clipText: string) => {
        const textToPaste = clipText || localClipboard;
        if (textToPaste) {
          const newValue = textarea.value.substring(0, start) + textToPaste + textarea.value.substring(end);
          setEditorContent(newValue);
          setContextMenu(null);
          setTimeout(() => {
            textarea.focus();
            textarea.selectionStart = textarea.selectionEnd = start + textToPaste.length;
          }, 0);
        }
      };

      try {
        navigator.clipboard.readText()
          .then((clipText) => applyPaste(clipText))
          .catch(() => applyPaste(localClipboard));
      } catch (err) {
        applyPaste(localClipboard);
      }
    }
  };

  const handleCtxDelete = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      if (start !== end) {
        const newValue = textarea.value.substring(0, start) + textarea.value.substring(end);
        setEditorContent(newValue);
        setContextMenu(null);
        setTimeout(() => {
          textarea.focus();
          textarea.selectionStart = textarea.selectionEnd = start;
        }, 0);
      }
    }
  };

  const handleCtxLocateInExplorer = () => {
    setContextMenu(null);
    const customToastEv = new CustomEvent('soloforge-toast', {
      detail: {
        message: `在资源管理器定位成功: ${selectedFile}`,
        type: 'success'
      }
    });
    window.dispatchEvent(customToastEv);
  };

  const handleCtxSendToChat = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      const selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
      const textToSend = selectedText || safeContent;
      
      // Dispatch Chat target inputs
      window.dispatchEvent(new CustomEvent('send-code-to-chat', {
        detail: {
          text: textToSend,
          fileName: getFileDisplayName()
        }
      }));

      setContextMenu(null);

      const toast = new CustomEvent('soloforge-toast', {
        detail: {
          message: '代码段已自动填充至 AI 提问框',
          type: 'success'
        }
      });
      window.dispatchEvent(toast);
    }
  };

  // Determine selection availability for right-click utilities
  const hasSelectionSelection = textareaRef.current 
    ? (textareaRef.current.selectionStart !== textareaRef.current.selectionEnd) 
    : false;

  // Dynamic code tokens highlighting parser
  const highlightedHtml = React.useMemo(() => {
    if (!safeContent) return ' ';

    // Escape code characters so they don't break dynamic HTML rendering
    const escapeHtml = (text: string) => {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    // Combine regular patterns for syntax highlight
    const tokenRegex = new RegExp(
      '(' +
        // Comments (single & multi line)
        '(?:\\/\\/[^\n]*)|' +
        '(?:\\/\\*[\\s\\S]*?\\*\\/)|' +
        '(?:&lt;!--[\\s\\S]*?--&gt;)|' +
        // Strings
        '(?:"[^"\\\\]*(?:\\\\.[^"\\\\]*)*")|' +
        '(?:\'[^\'\\\\]*(?:\\\\.[^\'\\\\]*)*\')|' +
        '(?:`[^`\\\\]*(?:\\\\.[^`\\\\]*)*`)|' +
        // Keywords
        '\\b(?:const|let|var|function|return|class|export|import|from|as|default|if|else|for|while|switch|case|break|continue|true|false|null|undefined|async|await|try|catch|finally|throw|new|this|typeof|instanceof|interface|type|enum|private|public|protected|extends|implements|static|readonly|get|set)\\b|' +
        // Primitive Types / Objects
        '\\b(?:string|number|boolean|any|void|unknown|never|object|Array|Map|Set|Record|Promise|Error|JSON|Math|console|window|document|process|global)\\b|' +
        // Numbers
        '\\b\\d+(?:\\.\\d+)?\\b|' +
        // Opening / closing HTML-like markup tags
        '(&lt;\\/?[a-zA-Z0-9:-]+|\\/?&gt;)' +
      ')',
      'g'
    );

    const highlightText = (text: string) => {
      const escaped = escapeHtml(text);
      return escaped.replace(tokenRegex, (match) => {
        if (match.startsWith('//') || match.startsWith('/*') || match.startsWith('&lt;!--')) {
          return `<span style="color: var(--editor-outline); opacity: 0.65; font-style: italic;">${match}</span>`;
        }
        if (match.startsWith('"') || match.startsWith("'") || match.startsWith('`')) {
          return `<span style="color: var(--syntax-string); font-weight: 500;">${match}</span>`;
        }
        if (/^(?:const|let|var|function|return|class|export|import|from|as|default|if|else|for|while|switch|case|break|continue|true|false|null|undefined|async|await|try|catch|finally|throw|new|this|typeof|instanceof|interface|type|enum|private|public|protected|extends|implements|static|readonly|get|set)$/.test(match)) {
          return `<span style="color: var(--color-primary); font-weight: 700;">${match}</span>`;
        }
        if (/^(?:string|number|boolean|any|void|unknown|never|object|Array|Map|Set|Record|Promise|Error|JSON|Math|console|window|document|process|global)$/.test(match)) {
          return `<span style="color: var(--syntax-type); font-weight: 600;">${match}</span>`;
        }
        if (/^\d+(\.\d+)?$/.test(match)) {
          return `<span style="color: var(--syntax-number);">${match}</span>`;
        }
        if (match.startsWith('&lt;') || match.endsWith('&gt;')) {
          return `<span style="color: var(--color-primary); opacity: 0.95; font-weight: 600;">${match}</span>`;
        }
        return match;
      });
    };

    const lines = safeContent.split('\n');
    const highlightedLines = lines.map((lineText, idx) => {
      const lineNum = idx + 1;
      let lineHtml = highlightText(lineText);

      // Extract diagnostics on this line
      const lineDiag = diagnostics.filter(d => d.lineNum === lineNum);
      if (lineDiag.length > 0) {
        // Sort by severity (error > warning > info)
        const priority = { error: 3, warning: 2, info: 1 };
        const sorted = [...lineDiag].sort((a, b) => priority[b.severity] - priority[a.severity]);
        const prime = sorted[0];

        if (prime.word && lineText.includes(prime.word)) {
          // Highlight exact word outside HTML tag boundaries
          const escapedWord = escapeHtml(prime.word);
          const regex = new RegExp(`(${escapedWord})(?![^<]*>)`, 'g');
          lineHtml = lineHtml.replace(regex, `<span class="squiggly-${prime.severity}" title="${prime.text}">$1</span>`);
        } else {
          // Underline entire line code body (leaving tabs/spaces untouched)
          const matchSpaces = lineHtml.match(/^([ \t]*)(.*)$/);
          if (matchSpaces) {
            const spaces = matchSpaces[1];
            const content = matchSpaces[2];
            if (content.trim()) {
              lineHtml = `${spaces}<span class="squiggly-${prime.severity}" title="${prime.text}">${content}</span>`;
            }
          }
        }
      }
      return lineHtml;
    });

    return highlightedLines.join('\n') + '\n';
  }, [safeContent, diagnostics]);

  return (
    <div 
      className="flex-1 flex flex-col h-full overflow-hidden relative"
      style={{ 
        backgroundColor: 'var(--editor-bg)', 
        color: 'var(--editor-on-surface)',
        containerType: 'inline-size'
      }}
    >
      <style>{`
        @container (max-width: 290px) {
          .editor-footer-charcount {
            display: none !important;
          }
          .editor-footer-mode {
            display: none !important;
          }
        }
        @container (max-width: 220px) {
          .editor-footer {
            display: none !important;
          }
        }
        .custom-editor-scrollbar::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .custom-editor-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-editor-scrollbar::-webkit-scrollbar-thumb {
          background: var(--editor-outline);
          border-radius: 4px;
        }
        .custom-editor-scrollbar::-webkit-scrollbar-thumb:hover {
          background: var(--color-primary);
        }
        .custom-editor-text-area::selection {
          background-color: rgba(var(--color-primary-rgb), 0.25);
          -webkit-text-fill-color: var(--editor-on-surface);
          color: var(--editor-on-surface);
        }
        .custom-pre-renderer::-webkit-scrollbar {
          display: none;
        }
        .squiggly-error {
          text-decoration: underline wavy #ef4444 1.5px;
          text-underline-offset: 3px;
        }
        .squiggly-warning {
          text-decoration: underline wavy #f59e0b 1.5px;
          text-underline-offset: 3px;
        }
        .squiggly-info {
          text-decoration: underline wavy #3b82f6 1.5px;
          text-underline-offset: 3px;
        }
      `}</style>

      {/* Editor top-bar display header */}
      <div 
        className="h-10 border-b px-4 flex items-center justify-between shrink-0 select-none"
        style={{ backgroundColor: 'var(--editor-surface)', borderColor: 'var(--editor-outline)' }}
      >
        <div className="flex items-center gap-2 text-[11px] font-sans">
          <FileCode className="w-4 h-4 shrink-0" style={{ color: 'var(--color-primary)' }} />
          <span className="font-semibold">{getFileDisplayName()}</span>
          {isPopoutView && (
            <span 
              className="ml-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-bold border"
              style={{ 
                backgroundColor: 'rgba(var(--color-primary-rgb), 0.1)', 
                borderColor: 'rgba(var(--color-primary-rgb), 0.25)',
                color: 'var(--color-primary)'
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: 'var(--color-primary)' }} />
              实时同步中
            </span>
          )}
        </div>
        
        <div className="flex items-center gap-2">
          {/* Find Button (Ctrl+F trigger) */}
          <button
            onClick={() => setShowSearch(!showSearch)}
            className={`p-1 px-2 py-1 rounded transition-all cursor-pointer border ${
              showSearch 
                ? 'bg-primary/20 text-primary border-primary/40' 
                : 'hover:bg-neutral-500/10 border-transparent text-on-surface/60 hover:text-on-surface'
            }`}
            title="搜索与替换 (Ctrl+F)"
          >
            <Search className="w-4 h-4" />
          </button>

          {/* Copy Button */}
          <button
            onClick={handleCopy}
            className="p-1 px-2.5 py-1 text-[10px] font-semibold rounded border cursor-pointer transition-all flex items-center gap-1.5"
            style={{ 
              color: 'var(--editor-on-surface)', 
              opacity: 0.85,
              borderColor: 'var(--editor-outline)',
              backgroundColor: 'var(--editor-surface-bright)'
            }}
            title="复制代码"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-500" />
                <span>已复制</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" style={{ opacity: 0.6 }} />
                <span>复制</span>
              </>
            )}
          </button>
          
          {/* Popout Button */}
          {!isPopoutView && (
            <button
              onClick={handlePopout}
              className="p-1 px-2 py-1 rounded transition-all cursor-pointer hover:bg-neutral-500/10"
              style={{ color: 'var(--color-primary)' }}
              title="打开独立编辑器"
            >
              <ArrowUpRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumb Path representation bar */}
      <div 
        className="px-4 py-1.5 border-b flex items-center gap-1 text-[10px] select-none font-mono shrink-0"
        style={{ 
          backgroundColor: 'var(--editor-surface-bright)', 
          borderColor: 'var(--editor-outline)',
          color: 'var(--editor-on-surface)'
        }}
      >
        {relativePathSegments.map((segment, index) => (
          <React.Fragment key={index}>
            {index > 0 && <span className="opacity-40 px-1 text-[8px]">&gt;</span>}
            <span className={index === relativePathSegments.length - 1 ? 'opacity-90 font-semibold' : 'opacity-50'}>
              {segment}
            </span>
          </React.Fragment>
        ))}
      </div>

      {/* Find and Replace Panel */}
      {showSearch && (
        <div 
          className="border-b px-4 py-2.5 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 shrink-0 text-xs font-sans select-none"
          style={{ 
            backgroundColor: 'var(--editor-surface)', 
            borderColor: 'var(--editor-outline)' 
          }}
        >
          {/* Inputs Section */}
          <div className="flex-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            {/* Find field wrapper */}
            <div className="flex-1 relative flex items-center border rounded px-2.5 bg-bg/40 border-outline/40 focus-within:border-primary/60">
              <Search className="w-3.5 h-3.5 opacity-40 shrink-0 mr-1.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="查找代码..."
                className="w-full py-1.5 bg-transparent border-none text-xs outline-none focus:ring-0 text-on-surface placeholder:text-on-surface/30"
              />
              {searchQuery && (
                <span className="shrink-0 text-[10px] text-on-surface/40 pr-1.5 font-mono">
                  {searchMatches.length > 0 ? `${currentMatchIndex + 1}/${searchMatches.length}` : '无匹配'}
                </span>
              )}
            </div>

            {/* Replace field wrapper */}
            <div className="flex-1 relative flex items-center border rounded px-2.5 bg-bg/40 border-outline/40 focus-within:border-primary/60">
              <Replace className="w-3.5 h-3.5 opacity-40 shrink-0 mr-1.5" />
              <input
                type="text"
                value={replaceQuery}
                onChange={(e) => setReplaceQuery(e.target.value)}
                placeholder="替换为..."
                className="w-full py-1.5 bg-transparent border-none text-xs outline-none focus:ring-0 text-on-surface placeholder:text-on-surface/30"
              />
            </div>
          </div>

          {/* Action buttons and navigation */}
          <div className="flex items-center gap-1.5 justify-end shrink-0">
            {/* Matches Navigation */}
            <div className="flex items-center border border-outline/40 rounded mr-0.5 bg-bg/25">
              <button 
                onClick={handlePrevMatch}
                disabled={searchMatches.length === 0}
                className="p-1.5 hover:bg-surface-bright disabled:opacity-30 rounded-l cursor-pointer"
                title="上一个匹配"
              >
                <ChevronUp className="w-3.5 h-3.5 text-on-surface" />
              </button>
              <div className="w-[1px] h-3.5 bg-outline/40" />
              <button 
                onClick={handleNextMatch}
                disabled={searchMatches.length === 0}
                className="p-1.5 hover:bg-surface-bright disabled:opacity-30 rounded-r cursor-pointer"
                title="下一个匹配"
              >
                <ChevronDown className="w-3.5 h-3.5 text-on-surface" />
              </button>
            </div>

            {/* Replace Active Selector Button */}
            <button
              onClick={handleReplace}
              disabled={searchMatches.length === 0 || currentMatchIndex === -1}
              className="px-2.5 py-1.5 text-[10.5px] font-semibold bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 hover:border-primary/30 rounded disabled:opacity-30 disabled:pointer-events-none transition-all cursor-pointer"
            >
              主替换
            </button>

            {/* Replace All Selector Button */}
            <button
              onClick={handleReplaceAll}
              disabled={searchMatches.length === 0}
              className="px-2.5 py-1.5 text-[10.5px] font-semibold bg-primary text-bg hover:opacity-90 rounded disabled:opacity-30 disabled:pointer-events-none transition-all cursor-pointer"
            >
              全部替换
            </button>

            {/* Close Toggle Panel Trigger icon */}
            <button
              onClick={() => setShowSearch(false)}
              className="p-1.5 hover:bg-surface-bright rounded text-on-surface/50 hover:text-on-surface ml-1 cursor-pointer"
              title="关闭查找栏"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Pristine Code Editing Workspace View */}
      <div className="flex-grow flex overflow-hidden relative">
        {/* Sync scrolled Line numbers block column */}
        <div 
          ref={lineNumbersRef}
          className="w-12 shrink-0 border-r pt-4 text-right pr-3 font-mono text-[11px] select-none overflow-hidden leading-relaxed custom-editor-scrollbar pb-8"
          style={{ 
            backgroundColor: 'var(--editor-surface)', 
            borderRightColor: 'var(--editor-outline)',
            color: 'var(--editor-on-surface)'
          }}
        >
          {lineNumbers.map((lineNum) => (
            <div key={lineNum} style={{ height: '20px' }} className="flex items-center justify-end font-medium opacity-30">
              {lineNum}
            </div>
          ))}
        </div>

        {/* Double layered dynamic workspace */}
        <div className="flex-grow h-full relative overflow-hidden" onContextMenu={handleContextMenu}>
          {/* Layer 1: Color highlighted text render box */}
          <pre
            ref={preRef}
            className="absolute inset-0 p-4 pl-3.5 font-mono text-[11.5px] leading-relaxed select-none overflow-auto whitespace-pre pointer-events-none tab-size-4 pr-12 pb-8 bg-transparent custom-pre-renderer animate-fadeIn"
            style={{ 
              lineHeight: '20px',
              scrollbarWidth: 'none',
              msOverflowStyle: 'none'
            }}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />

          {/* Layer 2: Fully transparent editable text field */}
          <textarea
            ref={textareaRef}
            value={safeContent}
            onChange={(e) => setEditorContent(e.target.value)}
            onScroll={handleScroll}
            onSelect={handleSelectionChange}
            onKeyUp={handleSelectionChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className="custom-editor-text-area absolute inset-0 p-4 pl-3.5 font-mono text-[11.5px] leading-relaxed bg-transparent outline-none border-none resize-none select-text whitespace-pre tab-size-4 w-full h-full pb-8 overflow-auto focus:ring-0 focus:outline-none custom-editor-scrollbar"
            style={{ 
              lineHeight: '20px',
              color: 'transparent',
              caretColor: 'var(--color-primary)',
              WebkitTextFillColor: 'transparent',
            }}
            spellCheck="false"
          />
        </div>
      </div>

      {/* Collapsible Problems / Diagnostics Drawer */}
      {showDiagnostics && (
        <div 
          className="h-36 border-t flex flex-col shrink-0 text-xs select-none font-sans"
          style={{ 
            backgroundColor: 'var(--editor-surface)', 
            borderColor: 'var(--editor-outline)',
            color: 'var(--editor-on-surface)'
          }}
        >
          {/* Header */}
          <div className="h-8 px-4 flex items-center justify-between border-b border-outline/35 shrink-0 bg-neutral-900/35">
            <div className="flex items-center gap-2 font-bold">
              <span>代码实时静态诊断报告</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-primary/20 text-primary font-mono">
                {diagnostics.length} 提示项
              </span>
            </div>
            <button 
              onClick={() => setShowDiagnostics(false)}
              className="p-1 hover:bg-neutral-500/15 rounded text-on-surface/50 hover:text-on-surface cursor-pointer"
              title="隐藏面板"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* List content */}
          <div className="flex-grow overflow-y-auto p-2.5 space-y-1.5 custom-editor-scrollbar">
            {diagnostics.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center py-4 gap-1.5 select-none text-[11px]" style={{ color: 'var(--editor-on-surface)', opacity: 0.5 }}>
                <Check className="w-6 h-6 text-green-500" />
                <span>实时编译器/静态分析器评估：未在当前代码发现任何语法、括号失配或逻辑安全隐患</span>
              </div>
            ) : (
              diagnostics.map((d, index) => {
                let colorClass = 'text-red-400';
                let borderStyle = 'border-red-500/15 bg-red-500/5 hover:bg-red-500/10';
                let Icon = AlertCircle;
                if (d.severity === 'warning') {
                  colorClass = 'text-amber-400';
                  borderStyle = 'border-amber-500/15 bg-amber-500/5 hover:bg-amber-500/10';
                  Icon = AlertTriangle;
                } else if (d.severity === 'info') {
                  colorClass = 'text-blue-400';
                  borderStyle = 'border-blue-500/15 bg-blue-500/5 hover:bg-blue-500/10';
                  Icon = Info;
                }

                return (
                  <div 
                    key={index}
                    onClick={() => jumpToLine(d.lineNum)}
                    className={`flex items-start gap-2.5 p-2 rounded border text-[11px] cursor-pointer transition-all ${borderStyle}`}
                  >
                    <span className={`font-mono text-[9px] font-bold px-1.5 py-0.5 rounded opacity-85 bg-neutral-900/40 shrink-0 ${colorClass}`}>
                      行 {d.lineNum}
                    </span>
                    <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${colorClass}`} />
                    <span className="flex-grow tracking-wide" style={{ color: 'var(--editor-on-surface)' }}>{d.text}</span>
                    {d.word && (
                      <span className="font-mono text-[9px] bg-neutral-500/15 px-1 py-0.2 rounded hover:bg-neutral-500/25" style={{ color: 'var(--editor-on-surface)', opacity: 0.5 }}>
                        {d.word}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Footer bar data status */}
      <div 
        className="h-6 px-4 border-t flex items-center justify-between text-[9px] font-mono select-none shrink-0 editor-footer"
        style={{ 
          backgroundColor: 'var(--editor-surface)', 
          borderColor: 'var(--editor-outline)',
          color: 'var(--editor-on-surface)'
        }}
      >
        <div className="flex items-center gap-4">
          <span className="opacity-60 editor-footer-cursor">行 {cursorPos.line}, 列 {cursorPos.col}</span>
          <span className="opacity-60 editor-footer-charcount">总字符数: {safeContent.length}</span>
          
          {/* Real-time Diagnostics Status Indicator Pillar */}
          <button 
            onClick={() => setShowDiagnostics(!showDiagnostics)}
            className="flex items-center gap-2 px-2 py-0.5 rounded text-[9px] font-semibold bg-neutral-500/10 hover:bg-neutral-500/20 transition-all cursor-pointer editor-footer-diagnostics"
            style={{ color: 'var(--editor-on-surface)' }}
            title="点击切换显示代码实时静态诊断面板"
          >
            {diagnostics.filter(d => d.severity === 'error').length > 0 ? (
              <span className="flex items-center gap-1 text-red-500 font-bold font-sans">
                <AlertCircle className="w-3 h-3 animate-pulse text-red-500" />
                <span>错误: {diagnostics.filter(d => d.severity === 'error').length}</span>
              </span>
            ) : null}
            {diagnostics.filter(d => d.severity === 'warning').length > 0 ? (
              <span className="flex items-center gap-1 text-amber-500 font-bold font-sans">
                <AlertTriangle className="w-3 h-3 text-amber-500" />
                <span>警告: {diagnostics.filter(d => d.severity === 'warning').length}</span>
              </span>
            ) : null}
            {diagnostics.filter(d => d.severity === 'info').length > 0 ? (
              <span className="flex items-center gap-1 text-blue-400 font-bold font-sans">
                <Info className="w-3 h-3 text-blue-400" />
                <span>信息: {diagnostics.filter(d => d.severity === 'info').length}</span>
              </span>
            ) : null}
            {diagnostics.length === 0 ? (
              <span className="text-green-500 font-sans flex items-center gap-1 hover:text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                <span>代码正常</span>
              </span>
            ) : null}
          </button>

          <span className="uppercase font-bold tracking-wide opacity-80 editor-footer-mode" style={{ color: 'var(--color-primary)' }}>
            {getLanguageDisplayName()}
          </span>
        </div>
      </div>

      {/* Absolute Dynamic Context Menu Overlay */}
      {contextMenu && contextMenu.visible && (
        <div 
          className="fixed z-[200] w-52 rounded-lg border shadow-xl py-1 backdrop-blur bg-opacity-95 text-xs font-sans select-none animate-scaleIn"
          style={{ 
            left: `${contextMenu.x}px`, 
            top: `${contextMenu.y}px`,
            backgroundColor: 'var(--editor-surface)',
            borderColor: 'var(--editor-outline)',
            color: 'var(--editor-on-surface)'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Send to Chat button option */}
          <button
            onClick={handleCtxSendToChat}
            className="w-full text-left px-3.5 py-2 flex items-center justify-between transition-all hover:bg-neutral-500/10"
            style={{ color: 'var(--editor-on-surface)' }}
          >
            <span className="flex items-center gap-2">
              <MessageSquare className="w-3.5 h-3.5 opacity-70" />
              <span>发送到对话</span>
            </span>
            <span className="text-[10px] opacity-40 font-mono">Alt+Enter</span>
          </button>

          <div className="h-[1px] my-1 opacity-25" style={{ backgroundColor: 'var(--editor-outline)' }} />

          {/* Copy Option */}
          <button
            onClick={handleCtxCopy}
            className="w-full text-left px-3.5 py-2 flex items-center justify-between transition-all hover:bg-neutral-500/10"
            style={{ color: 'var(--editor-on-surface)' }}
          >
            <span className="flex items-center gap-2">
              <Copy className="w-3.5 h-3.5 opacity-70" />
              <span>{hasSelectionSelection ? '复制' : '复制全部'}</span>
            </span>
            <span className="text-[10px] opacity-40 font-mono">Ctrl+C</span>
          </button>

          {/* Cut Option */}
          <button
            onClick={handleCtxCut}
            disabled={!hasSelectionSelection}
            className="w-full text-left px-3.5 py-2 flex items-center justify-between transition-all hover:bg-neutral-500/10 disabled:opacity-30 disabled:pointer-events-none"
            style={{ color: 'var(--editor-on-surface)' }}
          >
            <span className="flex items-center gap-2">
              <Scissors className="w-3.5 h-3.5 opacity-70" style={{ transform: 'rotate(90deg)' }} />
              <span>剪切</span>
            </span>
            <span className="text-[10px] opacity-40 font-mono">Ctrl+X</span>
          </button>

          {/* Paste Option */}
          <button
            onClick={handleCtxPaste}
            className="w-full text-left px-3.5 py-2 flex items-center justify-between transition-all hover:bg-neutral-500/10"
            style={{ color: 'var(--editor-on-surface)' }}
          >
            <span className="flex items-center gap-2">
              <Clipboard className="w-3.5 h-3.5 opacity-70" />
              <span>粘贴</span>
            </span>
            <span className="text-[10px] opacity-40 font-mono">Ctrl+V</span>
          </button>

          {/* Delete Option */}
          <button
            onClick={handleCtxDelete}
            disabled={!hasSelectionSelection}
            className="w-full text-left px-3.5 py-2 flex items-center justify-between transition-all hover:bg-neutral-500/10 disabled:opacity-30 disabled:pointer-events-none"
            style={{ color: 'var(--editor-on-surface)' }}
          >
            <span className="flex items-center gap-2">
              <Trash2 className="w-3.5 h-3.5 opacity-70" />
              <span>删除</span>
            </span>
            <span className="text-[10px] opacity-40 font-mono">Del</span>
          </button>

          <div className="h-[1px] my-1 opacity-25" style={{ backgroundColor: 'var(--editor-outline)' }} />

          {/* Open In Explorer locate option */}
          <button
            onClick={handleCtxLocateInExplorer}
            className="w-full text-left px-3.5 py-2 flex items-center justify-between transition-all hover:bg-neutral-500/10"
            style={{ color: 'var(--editor-on-surface)' }}
          >
            <span className="flex items-center gap-2">
              <FolderOpen className="w-3.5 h-3.5 opacity-70" />
              <span>在资源管理打开</span>
            </span>
          </button>

          {/* Search and Replace option */}
          <button
            onClick={() => {
              setShowSearch(true);
              setContextMenu(null);
            }}
            className="w-full text-left px-3.5 py-2 flex items-center justify-between transition-all hover:bg-neutral-500/10"
            style={{ color: 'var(--editor-on-surface)' }}
          >
            <span className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5 opacity-70" />
              <span>搜索替换</span>
            </span>
            <span className="text-[10px] opacity-40 font-mono">Ctrl+F</span>
          </button>
        </div>
      )}
    </div>
  );
}
