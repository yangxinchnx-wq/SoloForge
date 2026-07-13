/**
 * SessionState / DeviceInstance 运行时类型校验
 *
 * 设计原则：
 * - 不引入第三方校验库 (zod/valibot)
 * - 全部用 TypeScript 严格类型守卫 (type predicates)
 * - 校验失败时打印 warn 并返回 null，不抛异常
 * - 损坏数据不应让 UI 崩溃
 *
 * 用法:
 *   const state = await garnet.getSessionState(id);
 *   if (!isSessionState(state)) {
 *     console.warn('Garnet 中的数据已损坏');
 *     return null;
 *   }
 */

import type {
  DeviceInstance,
  ScreenUV,
  SessionState,
  ScreenUVPoint,
  DeviceNativeSize,
} from './types';

/**
 * 是否为有限数字
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 是否为 0~1 之间的合法比例
 */
function isUnitRatio(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 1;
}

/**
 * 是否为非空字符串
 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 是否为合法 HEX 颜色 (#RRGGBB)
 */
function isHexColor(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

/**
 * 校验 ScreenUVPoint
 */
function isScreenUVPoint(v: unknown): v is ScreenUVPoint {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return isFiniteNumber(p.x) && isFiniteNumber(p.y);
}

/**
 * 校验 ScreenUV
 */
function isScreenUV(v: unknown): v is ScreenUV {
  if (typeof v !== 'object' || v === null) return false;
  const uv = v as Record<string, unknown>;
  return (
    isScreenUVPoint(uv.bl) &&
    isScreenUVPoint(uv.br) &&
    isScreenUVPoint(uv.tr) &&
    isScreenUVPoint(uv.tl)
  );
}

/**
 * 校验 DeviceNativeSize
 */
function isDeviceNativeSize(v: unknown): v is DeviceNativeSize {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return isFiniteNumber(s.w) && s.w > 0 && isFiniteNumber(s.h) && s.h > 0;
}

/**
 * 校验单个 DeviceInstance
 */
export function isDeviceInstance(v: unknown): v is DeviceInstance {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;

  return (
    isNonEmptyString(d.id) &&
    isNonEmptyString(d.modelKey) &&
    isUnitRatio(d.xRatio) &&
    isUnitRatio(d.yRatio) &&
    isFiniteNumber(d.rotationX) &&
    isFiniteNumber(d.rotationY) &&
    isFiniteNumber(d.rotationZ) &&
    isFiniteNumber(d.displayScale) &&
    d.displayScale > 0 &&
    typeof d.isSelected === 'boolean' &&
    isHexColor(d.highlightColor)
  );
}

/**
 * 校验 DeviceInstance 数组
 */
export function isDeviceInstanceArray(v: unknown): v is DeviceInstance[] {
  if (!Array.isArray(v)) return false;
  return v.every(isDeviceInstance);
}

/**
 * 校验 SessionState
 *
 * 严格模式：所有字段都必须通过类型守卫
 * 任一字段不合法 → 整体返回 false
 */
export function isSessionState(v: unknown): v is SessionState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;

  return (
    isNonEmptyString(s.sessionId) &&
    typeof s.selectedDeviceKey === 'string' && // 允许空字符串 (表示未选)
    isDeviceInstanceArray(s.devices) &&
    isHexColor(s.bgColor) &&
    (s.selectedDeviceId === null || isNonEmptyString(s.selectedDeviceId)) &&
    isSelectedIdsArray(s.selectedDeviceIds) &&
    isFiniteNumber(s.lastUpdated)
  );
}

/**
 * s2.2: 校验 selectedDeviceIds 数组
 *
 * - 必须是数组
 * - 元素都是非空 string
 * - 内部无重复
 * - 元素集合必须 ⊆ devices.id (避免野指针)
 *   严格模式下做这个检查太严, 用一个独立 helper 实现, 这里只做基础形状
 */
function isSelectedIdsArray(v: unknown): v is string[] {
  if (!Array.isArray(v)) return false;
  const seen = new Set<string>();
  for (const id of v) {
    if (typeof id !== 'string' || id.length === 0) return false;
    if (seen.has(id)) return false; // 内部不能重复
    seen.add(id);
  }
  return true;
}

/**
 * 校验 ScreenUV (公开, 用于 device-config.json)
 */
export function validateScreenUV(v: unknown): v is ScreenUV {
  return isScreenUV(v);
}

/**
 * 校验 DeviceNativeSize (公开)
 */
export function validateDeviceNativeSize(v: unknown): v is DeviceNativeSize {
  return isDeviceNativeSize(v);
}

/**
 * 软修复 SessionState
 *
 * 当 JSON 数据基本合法但某些可选字段缺失时，
 * 尝试用默认值补齐，而不是直接丢弃。
 *
 * 返回 null 表示无法修复。
 */
export function repairSessionState(v: unknown): SessionState | null {
  if (typeof v !== 'object' || v === null) return null;
  const raw = v as Record<string, unknown>;

  if (!isNonEmptyString(raw.sessionId)) return null;

  // P0: ACL 字段缺失时软修复 (老数据兼容)
  //   - ownerChatSessionId 缺 → null (无归属, 第一个使用者获得归属权)
  //   - name 缺 → 派生自 sessionId (兼容旧 canvas-{chatId} 命名)
  //   - visibility 缺 → 默认 'public' (与新规则一致)
  //   - lastAccessedBy 缺 → 空对象 (没人访问过)
  const legacyName = String(raw.sessionId);  // 兜底字符串, parseCanvasName 返回 -1
  const ownerRaw = raw.ownerChatSessionId;
  const ownerFallback = isNonEmptyString(ownerRaw) && ownerRaw !== 'legacy'
    ? ownerRaw
    : null;

  return {
    sessionId: raw.sessionId,
    name: isNonEmptyString(raw.name) ? raw.name : legacyName,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    createdAt: isFiniteNumber(raw.createdAt) ? raw.createdAt : undefined,
    selectedDeviceKey: typeof raw.selectedDeviceKey === 'string' ? raw.selectedDeviceKey : 'fill',
    devices: isDeviceInstanceArray(raw.devices) ? raw.devices : [],
    bgColor: isHexColor(raw.bgColor) ? raw.bgColor : '#FFFFFF',
    selectedDeviceId:
      raw.selectedDeviceId === null || isNonEmptyString(raw.selectedDeviceId)
        ? (raw.selectedDeviceId as string | null)
        : null,
    // s2.2: 多选设备 ID 软修复
    //   - 缺字段时, 退化到 [selectedDeviceId] (单选状态)
    //   - 字段不是数组时, 退化到 []
    //   - 元素里有 selectedDeviceId 时保持它, 过滤掉野指针
    selectedDeviceIds: isSelectedIdsArray(raw.selectedDeviceIds)
      ? (raw.selectedDeviceIds as string[]).filter((id) => {
          // 仅保留存在于 devices 中的 ID
          const dev = (raw.devices as Array<{ id?: unknown }> | undefined) ?? [];
          return dev.some((d) => d.id === id);
        })
      : (raw.selectedDeviceId ? [raw.selectedDeviceId as string] : []),
    lastUpdated: isFiniteNumber(raw.lastUpdated) ? raw.lastUpdated : Date.now(),
    // P0: ACL 字段
    ownerChatSessionId: ownerFallback,
    visibility: raw.visibility === 'public' || raw.visibility === 'private'
      ? raw.visibility
      : 'public',
    lastAccessedBy: raw.lastAccessedBy && typeof raw.lastAccessedBy === 'object'
      ? (raw.lastAccessedBy as Record<string, number>)
      : {},
  };
}
