/**
 * 3D 设备模型交互覆盖层
 * - 选中/移动/旋转/删除/复制粘贴
 * - 4 象限智能避让 (Ctrl+V)
 * - 渐变流动描边
 *
 * 严格遵守 AGENTS.md:
 * - 不用 any
 * - 浮动面板直接 width/height 控制
 * - 4 角触控把手
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Box, Trash2, Copy, ClipboardPaste } from 'lucide-react';
import type { DeviceInstance } from '../services/canvas/types';
import {
  fetchSession,
  setSelectedDevice as apiSetSelectedDevice,
  setSelectedDevices as apiSetSelectedDevices,
  updateDeviceTransform as apiUpdateDeviceTransform,
  addDevice as apiAddDevice,
  removeDevice as apiRemoveDevice,
  flushSession as apiFlushSession,
  forceFlush as apiForceFlush,
} from '../services/canvas/sessionApi';
import { Canvas3DClient } from '../services/canvas/Canvas3DClient';

interface Model3DOverlayProps {
  sessionId: string;
  canvasWidth: number;
  canvasHeight: number;
  bgColor: string;
  /**
   * 当前画布模式 (selectedDeviceKey)。
   * 选尺寸预设变化时,需要重新 fetch session (因为后端会创建新 device)。
   */
  modelKey?: string | null;
  onRequestDelete: (deviceId: string, modelKey: string) => void;
  /**
   * s3.2b: Canvas3DClient 实例 — 用于推 RTT input 事件到 main
   * null = 画布未启动, 不推
   */
  canvasClient?: Canvas3DClient | null;
}

const HIGHLIGHT_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
  '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
];

/**
 * 4 象限智能避让算法
 * 1. 尝试 Q1 (右上) → Q2 (左上) → Q3 (左下) → Q4 (右下)
 * 2. 4 象限都占用 → 画布随机空白处
 * 3. 都满了 → 随机位置
 */
function findPastePosition(
  source: DeviceInstance,
  existing: DeviceInstance[],
  canvasWidth: number,
  canvasHeight: number,
  deviceDisplaySize: number = 200
): { xRatio: number; yRatio: number } {
  const QUADRANT_OFFSET = 0.08;  // ratio 偏移
  const safeRatio = (v: number) => Math.max(0.05, Math.min(0.95, v));

  const candidates = [
    { xRatio: source.xRatio + QUADRANT_OFFSET, yRatio: source.yRatio - QUADRANT_OFFSET },  // Q1
    { xRatio: source.xRatio - QUADRANT_OFFSET, yRatio: source.yRatio - QUADRANT_OFFSET },  // Q2
    { xRatio: source.xRatio - QUADRANT_OFFSET, yRatio: source.yRatio + QUADRANT_OFFSET },  // Q3
    { xRatio: source.xRatio + QUADRANT_OFFSET, yRatio: source.yRatio + QUADRANT_OFFSET },  // Q4
  ];

  const isOccupied = (xRatio: number, yRatio: number, idToSkip?: string): boolean => {
    const threshold = 0.12;  // 12% 画布范围内算重叠
    return existing.some((d) => {
      if (d.id === idToSkip) return false;
      return Math.abs(d.xRatio - xRatio) < threshold && Math.abs(d.yRatio - yRatio) < threshold;
    });
  };

  // 1. 尝试 4 象限
  for (const pos of candidates) {
    const safe = { xRatio: safeRatio(pos.xRatio), yRatio: safeRatio(pos.yRatio) };
    if (!isOccupied(safe.xRatio, safe.yRatio, source.id)) {
      return safe;
    }
  }

  // 2. 画布随机空白 (最多 50 次)
  for (let i = 0; i < 50; i++) {
    const pos = {
      xRatio: 0.1 + Math.random() * 0.8,
      yRatio: 0.1 + Math.random() * 0.8,
    };
    if (!isOccupied(pos.xRatio, pos.yRatio, source.id)) {
      return pos;
    }
  }

  // 3. 真没地方, 随机位置 (可能重叠)
  return {
    xRatio: 0.1 + Math.random() * 0.8,
    yRatio: 0.1 + Math.random() * 0.8,
  };
}

function randomColor(): string {
  return HIGHLIGHT_COLORS[Math.floor(Math.random() * HIGHLIGHT_COLORS.length)];
}

function randomId(): string {
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function Model3DOverlay({
  sessionId,
  canvasWidth,
  canvasHeight,
  bgColor,
  modelKey,
  onRequestDelete,
  canvasClient = null,
}: Model3DOverlayProps) {
  // 本地 state(UI 渲染真相)。HTTP API 是持久化真相。
  const [devices, setDevices] = useState<DeviceInstance[]>([]);
  // s2.2: 多选设备 ID 集合
  //   - selectedId: 主选 (最后点中的那个, 用于单键操作)
  //   - selectedIds: 群组选 (用于群组变换/批量删除)
  //   - 单一选择时, selectedIds 长度为 1
  //   - 每次 setSelectedIds 后, 主选同步到 selectedIds 的最后一个元素
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isRotating, setIsRotating] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [hoverDeviceId, setHoverDeviceId] = useState<string | null>(null);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    startXRatio: number;
    startYRatio: number;
    startRotX: number;
    startRotY: number;
  } | null>(null);
  /**
   * s2.2: 群组拖动起点 — 保存每个选中设备拖动开始时的 transform
   * key: deviceId, value: { xRatio, yRatio, rotationX, rotationY }
   * 群组移动时, 每个设备应用 (current - start), 这样多个设备保持相对位置
   */
  const groupStartRef = useRef<Map<string, { xRatio: number; yRatio: number; rotationX: number; rotationY: number }>>(new Map());
  const copiedDeviceRef = useRef<DeviceInstance | null>(null);

  // 加载: 组件挂载时从服务器拉一次
  // modelKey 变化时也重拉: 选尺寸预设 → 后端 selectDevice 创建新 device
  useEffect(() => {
    let cancelled = false;
    fetchSession(sessionId).then((state) => {
      if (cancelled) return;
      if (state) {
        setDevices([...state.devices]);
        setSelectedId(state.selectedDeviceId);
        // s2.2: 从 server 同步多选集
        setSelectedIds(new Set(state.selectedDeviceIds ?? []));
      }
    });
    return () => { cancelled = true; };
  }, [sessionId, modelKey]);

  // 右键菜单禁用 (AGENTS.md: 旋转依赖右键)
  useEffect(() => {
    const onContext = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('contextmenu', onContext);
    return () => window.removeEventListener('contextmenu', onContext);
  }, []);

  // s2.4: F5 / 关闭前强刷
  //
  // 浏览器在 unload 阶段, fetch 默认会被取消.
  // 用 keepalive: true 让请求在后台发出 (Chrome/Firefox 支持).
  // 监听两个事件提高命中率:
  //   - beforeunload: 用户按 F5, 关 tab, 关浏览器
  //   - pagehide: 移动端 / bfcache 场景, 比 beforeunload 更可靠
  useEffect(() => {
    const flush = () => {
      apiForceFlush(sessionId);
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [sessionId]);

  /**
   * 选中设备(乐观更新 + fire-and-forget PUT)
   *
   * s2.2: 支持 Shift 加选 / Ctrl+A 全选
   *   - 普通点击: 替换选中集为 {deviceId}
   *   - Shift 点击: 切换 deviceId 在选中集里的成员关系 (加选/取消)
   *   - Ctrl+A   : 选中所有设备
   */
  const handleSelect = useCallback((deviceId: string, opts?: { shiftKey?: boolean }) => {
    if (opts?.shiftKey) {
      // s2.2: Shift 加选 — 切换成员
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(deviceId)) {
          next.delete(deviceId);
        } else {
          next.add(deviceId);
        }
        // 主选: 选中的最后一个, 如果都被删了, 清空
        const newPrimary = next.size > 0 ? deviceId : null;
        setSelectedId(newPrimary);
        const ids = Array.from(next);
        apiSetSelectedDevices(sessionId, ids, newPrimary ?? undefined).catch(() => {});
        return next;
      });
    } else {
      // 普通点击: 替换选中集
      setSelectedId(deviceId);
      setSelectedIds(new Set([deviceId]));
      apiSetSelectedDevice(sessionId, deviceId).catch(() => {});
    }
  }, [sessionId]);

  /**
   * 取消选中 (清空所有选中)
   */
  const handleDeselect = useCallback(() => {
    setSelectedId(null);
    setSelectedIds(new Set());
    apiSetSelectedDevice(sessionId, null).catch(() => {});
  }, [sessionId]);

  /**
   * s2.2: 全选当前会话所有设备
   */
  const handleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(devices.map((d) => d.id));
      const newPrimary = devices[devices.length - 1]?.id ?? null;
      setSelectedId(newPrimary);
      const ids = Array.from(next);
      apiSetSelectedDevices(sessionId, ids, newPrimary ?? undefined).catch(() => {});
      return next;
    });
  }, [devices, sessionId]);

  /**
   * 鼠标按下 - 区分左键(选中)/滚轮(移动)/右键(旋转)
   *
   * s2.2: 群组拖动起点
   *   - 点中设备时, 如果它已选中 (在 selectedIds 内), 保持整个 selectedIds
   *     用于群组拖动; 否则只选这个
   *   - 把每个被拖设备当前的 transform 存到 groupStartRef
   */
  const handleMouseDown = useCallback((
    e: React.MouseEvent,
    device: DeviceInstance
  ) => {
    e.preventDefault();
    e.stopPropagation();

    // s2.2: 决定本次操作的设备集合
    //   - 如果 device 已在选中集, 用整个 selectedIds 群组操作
    //   - 否则, 替换为只选这个 (Shift 加选走 handleSelect 内部)
    let opIds: Set<string>;
    if (e.shiftKey) {
      // Shift 加选, 同步给 handleSelect
      handleSelect(device.id, { shiftKey: true });
      // 加选后选中集可能变化; 操作集取 (旧选中集 ∪ 自身) = 当前 selectedIds + device (去重)
      opIds = new Set(selectedIds);
      opIds.add(device.id);
    } else if (selectedIds.has(device.id)) {
      // 已选中: 群组操作
      opIds = new Set(selectedIds);
    } else {
      // 未选中: 替换为单选
      handleSelect(device.id);
      opIds = new Set([device.id]);
    }
    setSelectedId(device.id);

    // 记录每个被拖设备的起点 transform
    const starts = new Map<string, { xRatio: number; yRatio: number; rotationX: number; rotationY: number }>();
    for (const id of opIds) {
      const d = devices.find((x) => x.id === id);
      if (d) {
        starts.set(id, {
          xRatio: d.xRatio,
          yRatio: d.yRatio,
          rotationX: d.rotationX,
          rotationY: d.rotationY,
        });
      }
    }
    groupStartRef.current = starts;

    if (e.button === 2) {
      // 右键: 旋转 (群组)
      setIsRotating(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        startXRatio: device.xRatio,
        startYRatio: device.yRatio,
        startRotX: device.rotationX,
        startRotY: device.rotationY,
      };
    } else if (e.button === 1) {
      // 滚轮按下: 移动 (群组)
      setIsMoving(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        startXRatio: device.xRatio,
        startYRatio: device.yRatio,
        startRotX: 0,
        startRotY: 0,
      };
    } else {
      // 左键 (button 0): 选中 + 屏内 tap (s3.2b)
      // s3.2b: 计算 hit point 相对 device 屏幕矩形的 (u, v), 推到 main
      // 简化: 不考虑 rotationX/Y 透视, 走轴对齐近似
      // 未来扩展: 用矩阵反演算透视后的 (u, v)
      const uv = computeScreenUv(e as React.MouseEvent, device, canvasWidth, canvasHeight);
      if (uv && canvasClient) {
        canvasClient.pushRttInput({
          sessionId,
          deviceId: device.id,
          type: 'tap',
          u: uv.u,
          v: uv.v,
          timestamp: Date.now(),
        }).catch(() => {});
      }
    }
  }, [handleSelect, selectedIds, devices, sessionId, canvasWidth, canvasHeight, canvasClient]);

  /**
   * 全局 mousemove / mouseup - 性能优化: 用 passive listener
   */
  useEffect(() => {
    if (!isRotating && !isMoving) return;

    let rafId: number | null = null;
    let pendingTransform: { xRatio: number; yRatio: number; rotationX: number; rotationY: number } | null = null;
    let pendingServerTransform: { xRatio?: number; yRatio?: number; rotationX?: number; rotationY?: number } | null = null;
    let serverTimer: number | null = null;
    const SERVER_DEBOUNCE_MS = 80;  // mousemove 高频,80ms 防抖足够流畅

    /**
     * 推 transform 到 Flutter 画布 (经 preload IPC)
     *
     * 用 rAF 节流: mousemove 60-120Hz, rAF 锁到显示器刷新率 (~60Hz)
     * 即使 mousemove 触发 100 次, 实际 IPC 只发 60 次
     */
    const flushToFlutter = (): void => {
      if (!pendingTransform || !selectedId) return;
      const canvas = window.soloforge;
      if (canvas && typeof canvas.canvas.transformDevice === 'function') {
        canvas.canvas.transformDevice(sessionId, selectedId, {
          xRatio: pendingTransform.xRatio,
          yRatio: pendingTransform.yRatio,
          rotationX: pendingTransform.rotationX,
          rotationY: pendingTransform.rotationY,
        }).catch(() => {
          // IPC 失败不阻塞, 下一帧再试
        });
      }
      pendingTransform = null;
      rafId = null;
    };

    const scheduleFlush = (): void => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(flushToFlutter);
    };

    /**
     * 防抖写入服务器:mousemove 高频时,80ms 内的多次更新合并为 1 次 PUT
     */
    const scheduleServerWrite = (): void => {
      if (serverTimer !== null) return;
      serverTimer = window.setTimeout(() => {
        serverTimer = null;
        if (pendingServerTransform && selectedId) {
          const transform = pendingServerTransform;
          pendingServerTransform = null;
          apiUpdateDeviceTransform(sessionId, selectedId, transform).catch(() => {});
        }
      }, SERVER_DEBOUNCE_MS);
    };

    /**
     * 立即把 transform 合并到 server 待发队列(本地乐观更新)
     */
    const queueServerTransform = (next: { xRatio?: number; yRatio?: number; rotationX?: number; rotationY?: number }): void => {
      pendingServerTransform = { ...(pendingServerTransform || {}), ...next };
      scheduleServerWrite();
    };

    const onMove = (e: MouseEvent) => {
      if (!dragStartRef.current || !selectedId) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;

      if (isMoving) {
        // s2.2: 群组移动 — dx/dy 是相对主选 (selectedId) 起点的位移
        //   每个设备的新位置 = 自己的起点 + (dx/canvasW, dy/canvasH)
        const dXRatio = dx / canvasWidth;
        const dYRatio = dy / canvasHeight;
        const clamp = (v: number) => Math.max(0.05, Math.min(0.95, v));
        const groupStart = groupStartRef.current;
        setDevices((prev) => prev.map((d) => {
          const start = groupStart.get(d.id);
          if (!start) return d;
          return {
            ...d,
            xRatio: clamp(start.xRatio + dXRatio),
            yRatio: clamp(start.yRatio + dYRatio),
          };
        }));
        // 防抖写入 server (主选)
        queueServerTransform({
          xRatio: clamp(dragStartRef.current.startXRatio + dXRatio),
          yRatio: clamp(dragStartRef.current.startYRatio + dYRatio),
        });
        // Flutter IPC (主选)
        pendingTransform = {
          xRatio: clamp(dragStartRef.current.startXRatio + dXRatio),
          yRatio: clamp(dragStartRef.current.startYRatio + dYRatio),
          rotationX: dragStartRef.current.startRotX,
          rotationY: dragStartRef.current.startRotY,
        };
        scheduleFlush();
      } else if (isRotating) {
        const rotSpeed = 0.012;
        const dRotX = dy * rotSpeed;
        const dRotY = dx * rotSpeed;
        const groupStart = groupStartRef.current;
        setDevices((prev) => prev.map((d) => {
          const start = groupStart.get(d.id);
          if (!start) return d;
          return {
            ...d,
            rotationX: start.rotationX + dRotX,
            rotationY: start.rotationY + dRotY,
          };
        }));
        // 主选
        const mainXRatio = dragStartRef.current.startXRatio;
        const mainYRatio = dragStartRef.current.startYRatio;
        const newRotX = dragStartRef.current.startRotX + dRotX;
        const newRotY = dragStartRef.current.startRotY + dRotY;
        queueServerTransform({ rotationX: newRotX, rotationY: newRotY });
        pendingTransform = {
          xRatio: mainXRatio,
          yRatio: mainYRatio,
          rotationX: newRotX,
          rotationY: newRotY,
        };
        scheduleFlush();
      }
    };

    const onUp = () => {
      // 取消未执行的 rAF
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      // 最后一次强制推 (确保 mouseup 时的状态到位)
      flushToFlutter();

      // mouseup 时立即 flush 待发 server 数据(mousemove 防抖期间的最后一次)
      if (serverTimer !== null) {
        clearTimeout(serverTimer);
        serverTimer = null;
        if (pendingServerTransform && selectedId) {
          const transform = pendingServerTransform;
          pendingServerTransform = null;
          apiUpdateDeviceTransform(sessionId, selectedId, transform).catch(() => {});
        }
      }
      // s2.2: 群组操作时, 把 groupStart 里的其他设备也写一次 server
      //   注: 主选已经在上面 apiUpdateDeviceTransform 里写过了
      if (selectedId && groupStartRef.current.size > 1) {
        // 取所有被拖设备当前最终值, 主选跳过 (上面已写)
        const mainId = selectedId;
        // 读 devices 当前 state 困难 (闭包), 简化: 触发 transformGroup 让 server 算
        //   通过读 dragStartRef.current + groupStartRef, 算出每个非主选设备的 dXRatio/dYRatio
        const ds = dragStartRef.current;
        if (ds) {
          // 这里只能算移动增量, 旋转不专门写 (主选的 rotation 已经在主选里更新过)
          // 简化策略: 多选移动时, 直接 PUT 一次主选, 然后对每个非主选设备 PUT 自己的最新 transform
          // 群组 transform 协议 (transformGroup) 在群组结束后调用一次
          //   - 但 transformGroup 用的是 delta 增量, 而我们这里需要的是绝对值
          //   - 解决方案: 把每个非主选设备都走 updateDeviceTransform
          for (const [id, start] of groupStartRef.current.entries()) {
            if (id === mainId) continue;
            const cur = devices.find((d) => d.id === id);
            if (!cur) continue;
            // 移动: 起点 + (dx/canvasW, dy/canvasH)
            const dXRatio = (cur.xRatio - start.xRatio);
            const dYRatio = (cur.yRatio - start.yRatio);
            // 不直接传绝对值, 因为 mousemove 期间已经计算过 cur.xRatio/yRatio
            // 这里只确保 server 拿到最终状态
            apiUpdateDeviceTransform(sessionId, id, {
              xRatio: cur.xRatio,
              yRatio: cur.yRatio,
              rotationX: cur.rotationX,
              rotationY: cur.rotationY,
            }).catch(() => {});
          }
        }
      }
      // 强制 flush 到 Garnet(让最后位置立刻落盘)
      if (selectedId) {
        apiFlushSession(sessionId).catch(() => {});
      }
      setIsRotating(false);
      setIsMoving(false);
      dragStartRef.current = null;
      groupStartRef.current = new Map();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (serverTimer !== null) {
        clearTimeout(serverTimer);
        serverTimer = null;
      }
    };
  }, [isRotating, isMoving, selectedId, canvasWidth, canvasHeight, sessionId]);

  /**
   * 键盘快捷键: Delete / Ctrl+C / Ctrl+V / ESC / Ctrl+A
   *
   * s2.2: Delete 在多选时批量删; Ctrl+A 全选
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId) return;
      const device = devices.find((d) => d.id === selectedId);
      if (!device) return;

      // ESC - 取消所有选中
      if (e.key === 'Escape') {
        handleDeselect();
        return;
      }

      // s2.2: Ctrl+A - 全选当前会话所有设备
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A') && !e.shiftKey) {
        e.preventDefault();
        handleSelectAll();
        return;
      }

      // s2.2: Delete - 批量删除 (多选时) 或单删
      if (e.key === 'Delete') {
        e.preventDefault();
        if (selectedIds.size > 1) {
          // 批量删: 走 server removeDevice 多个 + 本地 setDevices 过滤
          const toDelete = Array.from(selectedIds);
          for (const id of toDelete) {
            apiRemoveDevice(sessionId, id).catch(() => {});
          }
          // 本地乐观更新
          setDevices((prev) => prev.filter((d) => !selectedIds.has(d.id)));
          handleDeselect();
        } else {
          onRequestDelete(device.id, device.modelKey);
        }
        return;
      }

      // Ctrl+C - 复制 (单选时复制当前设备, 多选时复制主选)
      if (e.ctrlKey && e.key === 'c' && !e.shiftKey) {
        e.preventDefault();
        copiedDeviceRef.current = { ...device };
        return;
      }

      // Ctrl+V - 粘贴 (4 象限智能避让)
      if (e.ctrlKey && e.key === 'v' && !e.shiftKey) {
        e.preventDefault();
        if (!copiedDeviceRef.current) return;
        const source = copiedDeviceRef.current;
        // 用本地 devices 算粘贴位置(避免依赖 serverStore)
        const pos = findPastePosition(source, devices, canvasWidth, canvasHeight);
        const newDevice: DeviceInstance = {
          ...source,
          id: randomId(),
          xRatio: pos.xRatio,
          yRatio: pos.yRatio,
          isSelected: true,
          highlightColor: randomColor(),
        };
        // 本地乐观更新
        setDevices((prev) => [...prev, newDevice]);
        setSelectedId(newDevice.id);
        // 同步到 server
        apiAddDevice(sessionId, newDevice).catch(() => {});
        apiSetSelectedDevice(sessionId, newDevice.id).catch(() => {});
        apiFlushSession(sessionId).catch(() => {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [devices, selectedId, selectedIds, handleDeselect, handleSelectAll, onRequestDelete, sessionId, canvasWidth, canvasHeight]);

  /**
   * 点击空白处取消选中
   */
  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleDeselect();
    }
  }, [handleDeselect]);

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ background: 'transparent' }}
      onMouseDown={handleBackgroundClick}
    >
      {devices.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-on-surface/40 text-xs font-mono pointer-events-none">
          拖入 .glb 模型 或 从尺寸预设选择设备
        </div>
      )}

      <AnimatePresence>
        {devices.map((device) => {
          const isSel = device.id === selectedId;
          const isHover = device.id === hoverDeviceId;
          const color = device.highlightColor;
          const left = device.xRatio * canvasWidth;
          const top = device.yRatio * canvasHeight;

          return (
            <motion.div
              key={device.id}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.15 }}
              className="absolute pointer-events-auto"
              style={{
                left: `${left}px`,
                top: `${top}px`,
                transform: 'translate(-50%, -50%)',
                cursor: isMoving ? 'grabbing' : isRotating ? 'ew-resize' : 'pointer',
                zIndex: isSel ? 50 : 10,
              }}
              onMouseDown={(e) => handleMouseDown(e, device)}
              onMouseEnter={() => setHoverDeviceId(device.id)}
              onMouseLeave={() => setHoverDeviceId(null)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div
                className="relative"
                style={{
                  width: '200px',
                  height: '200px',
                  background: 'rgba(40, 40, 60, 0.7)',
                  borderRadius: '16px',
                  border: `2px solid ${isSel ? color : 'rgba(255,255,255,0.15)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backdropFilter: 'blur(8px)',
                  boxShadow: isSel ? `0 0 24px ${color}88, 0 4px 16px rgba(0,0,0,0.3)` : '0 2px 8px rgba(0,0,0,0.2)',
                  transition: 'box-shadow 150ms ease',
                }}
              >
                <Box
                  className="w-12 h-12"
                  style={{ color: isSel ? color : 'rgba(255,255,255,0.4)' }}
                />
                <div
                  className="absolute bottom-2 left-2 right-2 text-center text-[10px] font-mono truncate"
                  style={{ color: isSel ? color : 'rgba(255,255,255,0.6)' }}
                >
                  {device.modelKey}
                </div>

                {/* 选中状态: 渐变流动描边 */}
                {isSel && (
                  <motion.div
                    className="absolute inset-0 rounded-2xl pointer-events-none"
                    style={{
                      background: `conic-gradient(from 0deg, ${color}00, ${color}ff, ${color}00, ${color}88, ${color}00)`,
                      WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                      WebkitMaskComposite: 'xor',
                      maskComposite: 'exclude',
                      padding: '2px',
                    }}
                    animate={{ rotate: 360 }}
                    transition={{ duration: 2.5, repeat: Infinity, ease: 'linear' }}
                  />
                )}

                {/* 悬浮/选中时显示的操作按钮组 */}
                {(isSel || isHover) && (
                  <div className="absolute -top-3 -right-3 flex gap-1">
                    {isSel && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          copiedDeviceRef.current = { ...device };
                        }}
                        className="w-7 h-7 rounded-full bg-primary hover:bg-primary/80 text-on-surface flex items-center justify-center shadow-lg transition-colors"
                        title="复制 (Ctrl+C)"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {isSel && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRequestDelete(device.id, device.modelKey);
                        }}
                        className="w-7 h-7 rounded-full bg-red-500 hover:bg-red-600 text-on-surface flex items-center justify-center shadow-lg transition-colors"
                        title="删除 (Delete)"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}

                {/* 粘贴提示 - 仅当选中后第一次按 Ctrl+V 时短暂显示 */}
                {isSel && copiedDeviceRef.current?.id === device.id && (
                  <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 px-2 py-1 rounded bg-primary/90 text-on-surface text-[10px] font-mono whitespace-nowrap flex items-center gap-1">
                    <ClipboardPaste className="w-3 h-3" />
                    已复制
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// s3.2b: 计算 hit point 相对 device 屏幕矩形的 (u, v) UV 坐标
//
// 简化版: 不考虑 rotationX/Y 透视, 走轴对齐近似
//   - 假设 device 卡片是 200x200 px 矩形 (与 model3DOverlay.tsx 中硬编码一致)
//   - 假设卡片中心 = (xRatio * canvasW, yRatio * canvasH)
//   - 假设卡片无旋转 (displayScale 应用后, 仍以中心为锚点)
// 未来扩展: 用矩阵反演算透视后的 (u, v)
//
// 返回 null = 不在屏幕内 (点击在 padding 边框上)
function computeScreenUv(
  e: React.MouseEvent,
  device: DeviceInstance,
  canvasWidth: number,
  canvasHeight: number,
): { u: number; v: number } | null {
  const baseSize = 200; // 与下面 style="width:200px; height:200px" 一致
  // 缩放后的实际尺寸
  const scaledSize = baseSize * device.displayScale;
  const halfSize = scaledSize / 2;
  // 设备卡片中心 (canvas 相对坐标, 即 react 端的 left/top)
  const cx = device.xRatio * canvasWidth;
  const cy = device.yRatio * canvasHeight;
  // hit point 相对 canvas 容器的本地坐标
  //   e.clientX/Y 是 viewport 相对, 需要减去 canvas 容器的偏移
  //   用 e.currentTarget (外层 div) 的 getBoundingClientRect
  const containerRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const localX = e.clientX - containerRect.left;
  const localY = e.clientY - containerRect.top;
  // 相对卡片中心的偏移
  const dx = localX - cx;
  const dy = localY - cy;
  // u/v: 中心 0.5, 边缘 0/1
  //   注意: React 端 y 向下, 但 UV y 向上 (V=0 是上边) — 需要翻转
  const u = (dx + halfSize) / scaledSize;
  const v = 1 - ((dy + halfSize) / scaledSize);
  // 越界检查
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u, v };
}
