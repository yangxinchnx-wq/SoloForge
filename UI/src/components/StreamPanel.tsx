import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Settings } from '../utils/icons';
import type { PermissionMode } from '../types/streaming';
import { promptCardPool } from '../services/promptCardPool';
import { usePromptCards } from '../hooks/usePromptCards';
import { PromptCard } from './PromptCard';
import { useAutoPersist, clearChatAll } from '../services/actorIntegration';
import { useStreamSummary } from '../services/useStreamSummary';
import { useStreamAppearanceStore } from '../state/streamAppearanceStore';
import { StreamContextMenu } from './StreamContextMenu';
import { ExecutionStream } from './ExecutionStream';

interface StreamPanelProps {
  chatId: string;
  mainModel: string;
  modelCount: number;
  permissionMode: PermissionMode;
}

export default function StreamPanel({ chatId, permissionMode }: StreamPanelProps) {
  const summary = useStreamSummary(chatId);
  useAutoPersist(chatId);

  const cards = usePromptCards(chatId);
  const blockingCards = cards.filter(card => card.spec.priority === 'blocking');
  const nonBlockingCards = cards.filter(card => card.spec.priority === 'non_blocking');
  const [expanded, setExpanded] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const fontColor = useStreamAppearanceStore(s => s.fontColor);
  const fontSize = useStreamAppearanceStore(s => s.fontSize);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const element = rootRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setCtxMenu({ x: event.clientX, y: event.clientY });
    };
    document.addEventListener('contextmenu', handler, true);
    return () => document.removeEventListener('contextmenu', handler, true);
  }, []);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setCtxMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const handleGearClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setCtxMenu({ x: rect.left, y: rect.bottom + 4 });
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        clearChatAll(chatId);
        promptCardPool.clearChat(chatId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [chatId]);

  if (!summary.hasData && blockingCards.length === 0 && nonBlockingCards.length === 0) return null;

  return (
    <>
      <div
        ref={rootRef}
        className="stream-process-root w-full flex flex-col gap-2 -mt-1.5 text-left pl-[5px] pr-[5px]"
        onContextMenu={handleContextMenu}
        style={{ '--stream-font-size': `${fontSize}px`, '--stream-font-color': fontColor || undefined } as React.CSSProperties}
        data-stream-color={fontColor ? '1' : undefined}
      >
        <div className="flex items-center justify-end -mb-1">
          <button type="button" title="流送区外观设置" onClick={handleGearClick} className="min-w-[40px] min-h-[40px] p-1 rounded-md text-on-surface/30 hover:text-primary hover:bg-primary/10 transition-colors flex items-center justify-center">
            <Settings className="w-3 h-3" />
          </button>
        </div>

        {blockingCards.map(card => (
          <PromptCard key={card.spec.id} instance={card} onResolve={action => promptCardPool.resolve(card.spec.id, action)} onTimeout={() => promptCardPool.expire(card.spec.id)} />
        ))}

        {summary.hasData && (
          <div>
            <button type="button" onClick={() => setExpanded(value => !value)} className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-on-surface/50 hover:text-on-surface/80 transition-colors mb-1 min-h-[40px]">
              {expanded ? <ChevronDown className="w-3 h-3 text-primary shrink-0" /> : <ChevronRight className="w-3 h-3 text-primary shrink-0" />}
              <span className="font-medium">执行过程</span>
              {summary.subtaskCount > 0 && <span className="text-[10px] text-on-surface/30 font-mono tabular-nums">{summary.doneCount}/{summary.subtaskCount}</span>}
            </button>
            {expanded && <ExecutionStream chatId={chatId} />}
          </div>
        )}

        {nonBlockingCards.map(card => (
          <PromptCard key={card.spec.id} instance={card} onResolve={action => promptCardPool.resolve(card.spec.id, action)} onTimeout={() => promptCardPool.expire(card.spec.id)} />
        ))}
      </div>

      {ctxMenu && createPortal(<StreamContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)} />, document.body)}
    </>
  );
}
