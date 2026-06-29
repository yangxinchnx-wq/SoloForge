import { describe, it, expect, beforeEach } from 'vitest';
import {
  sanitizeForIPC,
  __resetSanitizeForIPCWarnings,
} from '../electronStore';

describe('sanitizeForIPC — IPC 结构化克隆防御', () => {
  beforeEach(() => {
    __resetSanitizeForIPCWarnings();
  });

  describe('基础类型直通', () => {
    it.each([
      ['null', null, null],
      ['undefined', undefined, undefined],
      ['数字', 42, 42],
      ['数字 0', 0, 0],
      ['字符串', 'hello', 'hello'],
      ['空字符串', '', ''],
      ['布尔 true', true, true],
      ['布尔 false', false, false],
      ['BigInt', BigInt(999), '999'],
    ])('%s 原样返回', (_label, input, expected) => {
      expect(sanitizeForIPC(input)).toEqual(expected);
    });
  });

  describe('Function / Symbol 丢弃', () => {
    it('顶层函数 → undefined', () => {
      expect(sanitizeForIPC(() => 'x')).toBeUndefined();
    });
    it('对象里函数字段被丢弃', () => {
      const fn = () => 1;
      const result = sanitizeForIPC({ title: 'a', onClick: fn });
      expect(result).toEqual({ title: 'a' });
      expect((result as any).onClick).toBeUndefined();
    });
    it('Symbol 字段被丢弃', () => {
      const sym = Symbol('x');
      const result = sanitizeForIPC({ title: 'a', key: sym });
      expect(result).toEqual({ title: 'a' });
    });
    it('Lucide React 组件 (forwardRef 函数) 被丢弃', () => {
      // 模拟 forwardRef 返回的 React 组件: { $$typeof: Symbol(react.forward_ref), render: fn }
      const lucideIcon = (props: any) => null;
      const wrapped = Object.assign(lucideIcon, { $$typeof: Symbol.for('react.forward_ref') });
      const result = sanitizeForIPC({
        id: '1',
        title: '电商平台原型开发',
        tag: 'VUE',
        icon: wrapped,
        permission: 'normal',
      });
      expect(result).toEqual({
        id: '1',
        title: '电商平台原型开发',
        tag: 'VUE',
        permission: 'normal',
      });
      expect((result as any).icon).toBeUndefined();
    });
  });

  describe('Date / Array / Map / Set', () => {
    it('Date → ISO 字符串', () => {
      const d = new Date('2026-01-01T00:00:00Z');
      expect(sanitizeForIPC(d)).toBe('2026-01-01T00:00:00.000Z');
    });
    it('数组中函数元素被丢弃', () => {
      const result = sanitizeForIPC(['a', () => 1, 'b', null]);
      expect(result).toEqual(['a', 'b', null]);
    });
    it('Map → plain object', () => {
      const m = new Map<string, any>([['a', 1], ['b', () => 2]]);
      expect(sanitizeForIPC(m)).toEqual({ a: 1 });
    });
    it('Set → array', () => {
      const s = new Set<any>([1, 'x', () => 1]);
      expect(sanitizeForIPC(s)).toEqual([1, 'x']);
    });
  });

  describe('循环引用', () => {
    it('循环对象断环, 返回 undefined', () => {
      const obj: any = { a: 1 };
      obj.self = obj;
      const result = sanitizeForIPC({ wrapper: obj });
      expect(result).toEqual({ wrapper: { a: 1 } });
      // wrapper.self 在第二次访问时是循环, 应该被丢
      expect((result as any).wrapper.self).toBeUndefined();
    });
    it('直接传循环对象', () => {
      const obj: any = { a: 1 };
      obj.self = obj;
      // 不抛异常就算成功
      expect(() => sanitizeForIPC(obj)).not.toThrow();
    });
  });

  describe('React 元素 / DOM 节点', () => {
    it('有 $$typeof 的对象被丢弃', () => {
      const reactEl = { $$typeof: Symbol.for('react.element'), type: 'div', props: {} };
      expect(sanitizeForIPC({ el: reactEl, title: 'a' })).toEqual({ title: 'a' });
    });
    it('有 nodeType 的对象被丢弃', () => {
      const domNode = { nodeType: 1, nodeName: 'DIV' };
      expect(sanitizeForIPC({ node: domNode, title: 'a' })).toEqual({ title: 'a' });
    });
  });

  describe('深度嵌套', () => {
    it('5 层嵌套都清理干净', () => {
      const nested = {
        l1: {
          l2: {
            l3: {
              l4: {
                l5: {
                  fn: () => 1,
                  val: 'leaf',
                },
              },
            },
          },
        },
      };
      expect(sanitizeForIPC(nested)).toEqual({
        l1: { l2: { l3: { l4: { l5: { val: 'leaf' } } } } },
      });
    });
  });

  describe('实战场景: Soloforge chats 数组', () => {
    it('完整 chats 数组清理后不含任何函数', () => {
      // 模拟 HistoryAndEditorPanel 中真实的数据 (修复前会带着 icon 进 IPC)
      const chats = [
        {
          id: '1', title: '电商平台原型开发', time: '14:30',
          tag: 'VUE', tagBg: 'bg-blue-500/10', tagText: 'text-blue-400',
          icon: () => null, // ← 这个就是会爆的元凶
          permission: 'normal',
        },
        {
          id: '2', title: '用户认证 system 设计', time: '昨天',
          tag: 'AUTH', tagBg: 'bg-emerald-500/10', tagText: 'text-emerald-400',
          icon: () => null,
          permission: 'performance',
        },
      ];
      const sanitized = sanitizeForIPC(chats) as any[];
      expect(sanitized).toHaveLength(2);
      for (const chat of sanitized) {
        expect(chat.icon).toBeUndefined();
        expect(typeof chat.title).toBe('string');
        expect(typeof chat.tag).toBe('string');
      }
      // 确认整个 sanitized 结构可以被 JSON.stringify 完整序列化
      expect(() => JSON.stringify(sanitized)).not.toThrow();
    });
  });

  describe('不会抛异常', () => {
    it('永远不抛 (即使遇到怪异输入)', () => {
      const weird = [
        () => 1,
        undefined,
        null,
        Symbol('x'),
        BigInt(1),
        new Date(),
        [1, () => 2],
        { a: 1, b: () => 2 },
      ];
      expect(() => sanitizeForIPC(weird)).not.toThrow();
    });
  });
});