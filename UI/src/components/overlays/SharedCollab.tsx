// ─────────────────────────────────────────────────────────────────
// 远程协作 / 共享便签 — SharedCollab
// - 创建/加入协作房间 (短代码)
// - 共享便签 / 标注 / 评论
// - 内置模拟多人活动 (无后端时演示用)
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Tooltip, IconButton, Badge, Button } from '../ui/Button';

interface Props {
  open: boolean;
  onClose: () => void;
  userName?: string;
}

interface Room {
  id: string;
  code: string;       // 6 字符加入码
  name: string;
  owner: string;
  createdAt: number;
  members: Member[];
  notes: SharedNote[];
  annotations: Annotation[];
  chat: ChatMessage[];
  active: boolean;
}

interface Member {
  id: string;
  name: string;
  color: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: number;
  online: boolean;
  cursor?: { x: number; y: number };
}

interface SharedNote {
  id: string;
  author: string;
  text: string;
  ts: number;
  pinned: boolean;
  reactions: Record<string, string[]>;  // emoji -> user names
}

interface Annotation {
  id: string;
  author: string;
  file: string;
  line: number;
  text: string;
  ts: number;
  resolved: boolean;
}

interface ChatMessage {
  id: string;
  author: string;
  text: string;
  ts: number;
}

const STORAGE_KEY = 'soloforge.collab.rooms.v1';
const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

function generateCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function loadRooms(): Room[] {
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch { /* ignore */ }
  return [];
}
function saveRooms(rooms: Room[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms)); } catch { /* ignore */ }
}

const EMOJIS = ['👍', '❤️', '🎉', '👀', '🤔', '✅', '🔥', '💡'];

export function SharedCollab({ open, onClose, userName = 'me' }: Props) {
  const [rooms, setRooms] = useState<Room[]>(loadRooms);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [newRoomName, setNewRoomName] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const chatScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { saveRooms(rooms); }, [rooms]);

  const activeRoom = useMemo(() => rooms.find(r => r.id === activeRoomId) || null, [rooms, activeRoomId]);

  const createRoom = useCallback(() => {
    if (!newRoomName.trim()) return;
    const now = Date.now();
    const id = 'r_' + now.toString(36);
    const code = generateCode();
    const newRoom: Room = {
      id,
      code,
      name: newRoomName,
      owner: userName,
      createdAt: now,
      members: [
        { id: 'm1', name: userName, color: COLORS[0], role: 'owner', joinedAt: now, online: true },
        { id: 'm2', name: 'Alice',   color: COLORS[1], role: 'editor', joinedAt: now, online: true },
        { id: 'm3', name: 'Bob',     color: COLORS[2], role: 'editor', joinedAt: now, online: true },
      ],
      notes: [
        { id: 'n1', author: 'Alice', text: '欢迎加入协作!请把待办写在这里 📝', ts: now, pinned: true, reactions: { '👍': ['Bob'] } },
        { id: 'n2', author: 'Bob',   text: '我先来 review 一下代码',         ts: now, pinned: false, reactions: {} },
      ],
      annotations: [
        { id: 'a1', author: 'Alice', file: 'src/App.tsx', line: 42, text: '这里可以用 useMemo 优化', ts: now, resolved: false },
      ],
      chat: [
        { id: 'c1', author: 'Alice', text: '大家好!', ts: now - 600_000 },
        { id: 'c2', author: 'Bob',   text: '👋 刚加入', ts: now - 300_000 },
      ],
      active: true,
    };
    setRooms(prev => [newRoom, ...prev]);
    setActiveRoomId(id);
    setNewRoomName('');
  }, [newRoomName, userName]);

  const joinRoom = useCallback(() => {
    const r = rooms.find(x => x.code.toUpperCase() === joinCode.toUpperCase());
    if (r) {
      setActiveRoomId(r.id);
      setJoinCode('');
    } else {
      alert('未找到该房间代码');
    }
  }, [rooms, joinCode]);

  const leaveRoom = useCallback((id: string) => {
    setRooms(prev => prev.filter(r => r.id !== id));
    if (activeRoomId === id) setActiveRoomId(null);
  }, [activeRoomId]);

  const toggleActive = useCallback((id: string) => {
    setRooms(prev => prev.map(r => r.id === id ? { ...r, active: !r.active } : r));
  }, []);

  const addNote = useCallback(() => {
    if (!noteInput.trim() || !activeRoomId) return;
    const note: SharedNote = {
      id: 'n_' + Date.now().toString(36),
      author: userName,
      text: noteInput,
      ts: Date.now(),
      pinned: false,
      reactions: {},
    };
    setRooms(prev => prev.map(r => r.id === activeRoomId ? { ...r, notes: [...r.notes, note] } : r));
    setNoteInput('');
  }, [noteInput, activeRoomId, userName]);

  const reactToNote = useCallback((roomId: string, noteId: string, emoji: string) => {
    setRooms(prev => prev.map(r => {
      if (r.id !== roomId) return r;
      return {
        ...r,
        notes: r.notes.map(n => {
          if (n.id !== noteId) return n;
          const list = n.reactions[emoji] || [];
          if (list.includes(userName)) {
            const next = list.filter(u => u !== userName);
            if (next.length === 0) {
              const { [emoji]: _, ...rest } = n.reactions;
              return { ...n, reactions: rest };
            }
            return { ...n, reactions: { ...n.reactions, [emoji]: next } };
          }
          return { ...n, reactions: { ...n.reactions, [emoji]: [...list, userName] } };
        }),
      };
    }));
  }, [userName]);

  const pinNote = useCallback((roomId: string, noteId: string) => {
    setRooms(prev => prev.map(r => r.id === roomId ? {
      ...r,
      notes: r.notes.map(n => n.id === noteId ? { ...n, pinned: !n.pinned } : n),
    } : r));
  }, []);

  const deleteNote = useCallback((roomId: string, noteId: string) => {
    setRooms(prev => prev.map(r => r.id === roomId ? {
      ...r,
      notes: r.notes.filter(n => n.id !== noteId),
    } : r));
  }, []);

  const sendChat = useCallback(() => {
    if (!chatInput.trim() || !activeRoomId) return;
    const msg: ChatMessage = {
      id: 'c_' + Date.now().toString(36),
      author: userName,
      text: chatInput,
      ts: Date.now(),
    };
    setRooms(prev => prev.map(r => r.id === activeRoomId ? { ...r, chat: [...r.chat, msg] } : r));
    setChatInput('');
    setTimeout(() => {
      if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    }, 50);
  }, [chatInput, activeRoomId, userName]);

  const resolveAnnotation = useCallback((roomId: string, annId: string) => {
    setRooms(prev => prev.map(r => r.id === roomId ? {
      ...r,
      annotations: r.annotations.map(a => a.id === annId ? { ...a, resolved: !a.resolved } : a),
    } : r));
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-[1200px] max-w-[95vw] h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface-high shrink-0">
          <span className="material-symbols-outlined text-accent">group</span>
          <h2 className="text-sm font-semibold text-text">远程协作 · 共享房间</h2>
          <Badge variant="primary">{rooms.length} 个房间</Badge>
          <span className="text-xs text-text-secondary">当前用户 {userName}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="房间代码"
              className="bg-bg border border-border-light rounded px-2 h-7 text-xs font-mono text-text w-28"
            />
            <Button size="sm" icon="login" onClick={joinRoom}>加入</Button>
            <IconButton icon="close" onClick={onClose} />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 左:房间列表 */}
          <div className="w-64 border-r border-border bg-bg flex flex-col">
            <div className="p-2 border-b border-border">
              <div className="flex items-center gap-1">
                <input
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                  placeholder="新房间名..."
                  className="flex-1 bg-surface border border-border-light rounded px-2 h-7 text-xs text-text"
                />
                <IconButton icon="add" onClick={createRoom} />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {rooms.length === 0 ? (
                <div className="text-center text-xs text-text-secondary py-8">还没有房间</div>
              ) : (
                rooms.map(r => (
                  <div
                    key={r.id}
                    onClick={() => setActiveRoomId(r.id)}
                    className={'p-2 rounded-lg cursor-pointer transition border ' + (activeRoomId === r.id ? 'bg-accent/10 border-accent/30' : 'border-transparent hover:bg-surface-high')}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-text flex-1 truncate">{r.name}</span>
                      {r.active && <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />}
                    </div>
                    <div className="text-[10px] text-text-secondary mt-0.5 flex items-center gap-1">
                      <code className="font-mono bg-bg px-1 rounded">{r.code}</code>
                      <span>·</span>
                      <span>{r.members.filter(m => m.online).length}/{r.members.length}</span>
                    </div>
                    <div className="mt-1 flex -space-x-1">
                      {r.members.slice(0, 4).map(m => (
                        <div key={m.id} className="w-4 h-4 rounded-full border border-bg flex items-center justify-center text-[8px] text-white font-semibold"
                          style={{ background: m.color }}
                          title={m.name + (m.online ? ' (在线)' : '')}>
                          {m.name.slice(0, 1).toUpperCase()}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 右:房间详情 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {!activeRoom ? (
              <div className="flex-1 flex flex-col items-center justify-center text-text-secondary">
                <span className="material-symbols-outlined text-5xl opacity-30">group</span>
                <p className="mt-3 text-sm">创建或加入一个协作房间</p>
                <p className="text-xs mt-1">所有数据存储在本地,演示模式</p>
              </div>
            ) : (
              <>
                <div className="px-4 py-2.5 border-b border-border bg-surface-high flex items-center gap-3 shrink-0">
                  <h3 className="text-sm font-semibold text-text">{activeRoom.name}</h3>
                  <code className="text-[10px] font-mono text-accent bg-accent/10 px-1.5 rounded">{activeRoom.code}</code>
                  <Badge variant="info" dot pulse>{activeRoom.members.filter(m => m.online).length} 在线</Badge>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Tooltip content={activeRoom.active ? '暂停房间' : '激活房间'}>
                      <IconButton icon={activeRoom.active ? 'pause' : 'play_arrow'} onClick={() => toggleActive(activeRoom.id)} />
                    </Tooltip>
                    <Tooltip content="复制加入码"><IconButton icon="content_copy" onClick={() => navigator.clipboard?.writeText(activeRoom.code)} /></Tooltip>
                    <Tooltip content="离开"><IconButton icon="logout" onClick={() => leaveRoom(activeRoom.id)} /></Tooltip>
                  </div>
                </div>
                <div className="flex-1 grid grid-cols-3 gap-0 overflow-hidden">
                  {/* 成员 + 标注 */}
                  <div className="border-r border-border flex flex-col overflow-hidden">
                    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg">成员</div>
                    <div className="p-2 space-y-1 max-h-48 overflow-y-auto border-b border-border">
                      {activeRoom.members.map(m => (
                        <div key={m.id} className="flex items-center gap-2 p-1.5 rounded hover:bg-surface-high">
                          <div className="relative">
                            <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-semibold" style={{ background: m.color }}>
                              {m.name.slice(0, 1).toUpperCase()}
                            </div>
                            {m.online && <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-success border border-surface" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-text truncate">{m.name}</div>
                            <div className="text-[9px] text-text-secondary">{m.role === 'owner' ? '👑 房主' : m.role === 'editor' ? '✏️ 编辑者' : '👁️ 观察者'}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg">代码标注 ({activeRoom.annotations.length})</div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                      {activeRoom.annotations.map(a => (
                        <div key={a.id} className={'p-2 rounded border text-[11px] ' + (a.resolved ? 'bg-success/5 border-success/30 opacity-60' : 'bg-bg border-border')}>
                          <div className="flex items-center gap-1 mb-0.5">
                            <span className="font-mono text-accent text-[10px]">{a.file}:{a.line}</span>
                            <span className="text-text-secondary text-[10px] ml-auto">{a.author}</span>
                          </div>
                          <div className="text-text">{a.text}</div>
                          <div className="mt-1 flex items-center gap-1">
                            <button
                              onClick={() => resolveAnnotation(activeRoom.id, a.id)}
                              className="text-[9px] text-text-secondary hover:text-success"
                            >
                              {a.resolved ? '↺ 重新打开' : '✓ 解决'}
                            </button>
                          </div>
                        </div>
                      ))}
                      {activeRoom.annotations.length === 0 && <div className="text-xs text-text-secondary text-center py-2">无标注</div>}
                    </div>
                  </div>

                  {/* 共享便签 */}
                  <div className="border-r border-border flex flex-col overflow-hidden">
                    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg">共享便签 ({activeRoom.notes.length})</div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                      {activeRoom.notes.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned)).map(n => {
                        const author = activeRoom.members.find(m => m.name === n.author);
                        return (
                          <div key={n.id} className="bg-yellow-200/90 rounded p-2 text-[11px] text-text">
                            <div className="flex items-center gap-1 mb-1">
                              <span className="w-4 h-4 rounded-full text-[8px] font-semibold text-white flex items-center justify-center" style={{ background: author?.color || '#666' }}>
                                {n.author.slice(0, 1)}
                              </span>
                              <span className="font-semibold text-text">{n.author}</span>
                              {n.pinned && <span className="material-symbols-outlined text-xs filled text-yellow-700">push_pin</span>}
                              <span className="text-text-secondary text-[9px] ml-auto">{new Date(n.ts).toLocaleTimeString().slice(0, 5)}</span>
                            </div>
                            <div className="whitespace-pre-wrap break-words">{n.text}</div>
                            <div className="mt-1 flex items-center gap-1 flex-wrap">
                              {Object.entries(n.reactions).map(([emoji, users]) => (
                                <button
                                  key={emoji}
                                  onClick={() => reactToNote(activeRoom.id, n.id, emoji)}
                                  className={'text-[10px] px-1 rounded ' + (users.includes(userName) ? 'bg-accent/20 ring-1 ring-accent' : 'bg-black/10 hover:bg-black/20')}
                                >
                                  {emoji} {users.length}
                                </button>
                              ))}
                              <div className="ml-auto flex gap-0.5">
                                <Tooltip content="表情回应"><select
                                  onChange={(e) => { if (e.target.value) { reactToNote(activeRoom.id, n.id, e.target.value); e.target.value = ''; } }}
                                  className="text-[10px] bg-transparent border-none outline-none cursor-pointer"
                                >
                                  <option value="">+ 表情</option>
                                  {EMOJIS.map(em => <option key={em} value={em}>{em}</option>)}
                                </select></Tooltip>
                                <Tooltip content="钉住"><button onClick={() => pinNote(activeRoom.id, n.id)} className="material-symbols-outlined text-xs text-text-secondary">push_pin</button></Tooltip>
                                <Tooltip content="删除"><button onClick={() => deleteNote(activeRoom.id, n.id)} className="material-symbols-outlined text-xs text-text-secondary">close</button></Tooltip>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="border-t border-border p-2 flex gap-1">
                      <input
                        value={noteInput}
                        onChange={(e) => setNoteInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addNote()}
                        placeholder="写一条便签..."
                        className="flex-1 bg-bg border border-border-light rounded px-2 h-7 text-[11px] text-text"
                      />
                      <IconButton icon="send" onClick={addNote} />
                    </div>
                  </div>

                  {/* 群聊 */}
                  <div className="flex flex-col overflow-hidden">
                    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-secondary border-b border-border-light bg-bg">群聊</div>
                    <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-2 space-y-1">
                      {activeRoom.chat.map(m => {
                        const author = activeRoom.members.find(mm => mm.name === m.author);
                        const isMe = m.author === userName;
                        return (
                          <div key={m.id} className={'flex gap-1.5 ' + (isMe ? 'flex-row-reverse' : '')}>
                            <div className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[8px] font-semibold shrink-0" style={{ background: author?.color || '#666' }}>
                              {m.author.slice(0, 1)}
                            </div>
                            <div className={'max-w-[70%] ' + (isMe ? 'items-end' : '')}>
                              <div className="text-[9px] text-text-secondary mb-0.5">{m.author} · {new Date(m.ts).toLocaleTimeString().slice(0, 5)}</div>
                              <div className={'px-2 py-1 rounded-lg text-[11px] ' + (isMe ? 'bg-accent text-on-accent' : 'bg-bg text-text border border-border')}>
                                {m.text}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="border-t border-border p-2 flex gap-1">
                      <input
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && sendChat()}
                        placeholder="发消息..."
                        className="flex-1 bg-bg border border-border-light rounded px-2 h-7 text-[11px] text-text"
                      />
                      <IconButton icon="send" onClick={sendChat} />
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
