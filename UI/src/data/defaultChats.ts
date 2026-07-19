import { Code, Key, Brain, Database, CreditCard, HelpCircle } from '../utils/icons';
import { DefaultChatIcon, WindowsIcon, HarmonyOSIcon } from '../components/brandIcons';
import type { DraggableChatHistoryItem } from '../components/HistoryItem';

// 根据 tag 字段匹配对应的 icon 组件 (localStorage 解析时使用)
export function parseSavedChats(parsed: any[]): DraggableChatHistoryItem[] {
  return parsed.map((c: any) => {
    let iconComponent: any = DefaultChatIcon;
    if (c.tag === 'VUE') iconComponent = Code;
    else if (c.tag === 'AUTH') iconComponent = Key;
    else if (c.tag === 'AI') iconComponent = Brain;
    else if (c.tag === 'DB') iconComponent = Database;
    else if (c.tag === 'PAY') iconComponent = CreditCard;
    else if (c.tag === 'HELP') iconComponent = HelpCircle;
    else if (c.tag === 'WINDOWS') iconComponent = WindowsIcon;
    else if (c.tag === 'HARMONY') iconComponent = HarmonyOSIcon;
    else if (c.tag === 'NEW') iconComponent = DefaultChatIcon;
    return { ...c, icon: iconComponent };
  });
}

// 占位数据已清除 — 首次加载时侧边栏为空，用户自建对话后由 localStorage 持久化
export const DEFAULT_CHATS: DraggableChatHistoryItem[] = [];
