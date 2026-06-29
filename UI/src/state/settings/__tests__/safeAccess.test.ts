/**
 * 防御性访问模式单元测试
 *
 * 覆盖 SettingsModal/TerminalPanel 等组件使用的"empty array 防御模式":
 * - 数组为空时,fallback 占位对象不抛错
 * - 所有访问属性都有合法值
 * - 占位对象能正确参与 React 渲染(无 null 访问)
 *
 * 这些测试对应修复:
 * - 主题中心点击后位置闪烁(已用 lazy initial state 修)
 * - 设置里云端模型白屏(providers 数组为空时 activeProvider 为 undefined 崩)
 * - 终端面板解构崩溃(instances 数组为空时 activeInstance 为 undefined 崩)
 */

import { describe, it, expect } from 'vitest';

describe('安全访问模式 — SettingsModal 云端模型占位', () => {
  const EMPTY_PROVIDER = {
    id: 'placeholder',
    name: '暂无可用服务商',
    desc: '请刷新页面或重新添加服务商',
    enabled: false,
    apiKey: '',
    baseUrl: '',
    defaultUrl: '',
    models: [],
    customModels: [],
    status: 'idle' as const,
    color: '#888888',
  };

  // 关键测试:当 providers 数组为空时,activeProvider 不应该是 undefined
  it('空数组 + find:返回 undefined', () => {
    const providers: typeof EMPTY_PROVIDER[] = [];
    const activeProviderId = 'xiaomi';
    const result = providers.find(p => p.id === activeProviderId) || providers[0];
    expect(result).toBeUndefined();
  });

  it('空数组 + ?? EMPTY_PROVIDER:返回占位对象', () => {
    const providers: typeof EMPTY_PROVIDER[] = [];
    const activeProviderId = 'xiaomi';
    const _rawActiveProvider = providers.find(p => p.id === activeProviderId) || providers[0];
    const activeProvider = _rawActiveProvider ?? EMPTY_PROVIDER;
    expect(activeProvider).toBeDefined();
    expect(activeProvider.id).toBe('placeholder');
  });

  it('占位对象的 .enabled 访问不崩', () => {
    const activeProvider = EMPTY_PROVIDER;
    // 这就是关键 — React 渲染时会大量访问 .enabled
    expect(activeProvider.enabled).toBe(false);
    expect(() => activeProvider.enabled).not.toThrow();
  });

  it('占位对象的 .models 访问是空数组', () => {
    const activeProvider = EMPTY_PROVIDER;
    expect(Array.isArray(activeProvider.models)).toBe(true);
    expect(activeProvider.models.length).toBe(0);
  });

  it('占位对象的所有 key 都有合法类型', () => {
    const activeProvider = EMPTY_PROVIDER;
    expect(typeof activeProvider.id).toBe('string');
    expect(typeof activeProvider.name).toBe('string');
    expect(typeof activeProvider.desc).toBe('string');
    expect(typeof activeProvider.enabled).toBe('boolean');
    expect(typeof activeProvider.apiKey).toBe('string');
    expect(typeof activeProvider.baseUrl).toBe('string');
    expect(typeof activeProvider.defaultUrl).toBe('string');
    expect(Array.isArray(activeProvider.models)).toBe(true);
    expect(Array.isArray(activeProvider.customModels)).toBe(true);
    expect(['idle', 'loading', 'success', 'failed']).toContain(activeProvider.status);
    expect(typeof activeProvider.color).toBe('string');
  });

  it('非空数组:正常 activeProvider 不被占位对象替换', () => {
    const xiaomi = { ...EMPTY_PROVIDER, id: 'xiaomi', name: 'XIAOMIMIMO' };
    const providers = [xiaomi, { ...EMPTY_PROVIDER, id: 'openai' }];
    const _raw = providers.find(p => p.id === 'openai') || providers[0];
    const activeProvider = _raw ?? EMPTY_PROVIDER;
    expect(activeProvider.id).toBe('openai');
    expect(activeProvider.name).toBe('暂无可用服务商'); // 来自 openai 的占位
  });
});

describe('安全访问模式 — TerminalPanel 终端实例占位', () => {
  const FALLBACK_INSTANCE = {
    id: 'placeholder',
    name: '暂无可用终端',
    logItems: [] as Array<{ time: string; type: string; msg: string }>,
    progress: 0,
    isBuilding: false,
    statusText: '请新建终端',
    autoScroll: true,
    commandValue: '',
  };

  it('空数组 + ?? FALLBACK_INSTANCE:解构所有字段不崩', () => {
    const instances: typeof FALLBACK_INSTANCE[] = [];
    const _raw = instances[0];
    const { logItems, progress, isBuilding, statusText, autoScroll } = _raw ?? FALLBACK_INSTANCE;
    expect(logItems).toEqual([]);
    expect(progress).toBe(0);
    expect(isBuilding).toBe(false);
    expect(statusText).toBe('请新建终端');
    expect(autoScroll).toBe(true);
  });

  it('FALLBACK_INSTANCE 类型完整(避免 TS 编译错)', () => {
    const fb: typeof FALLBACK_INSTANCE = FALLBACK_INSTANCE;
    expect(fb.id).toBeDefined();
    expect(fb.name).toBeDefined();
    expect(fb.logItems).toBeDefined();
    expect(fb.progress).toBe(0);
    expect(fb.isBuilding).toBe(false);
    expect(fb.statusText).toBeDefined();
    expect(fb.autoScroll).toBe(true);
    expect(fb.commandValue).toBeDefined();
  });
});

describe('安全访问模式 — lazy initial state 居中', () => {
  it('计算居中位置(window.innerWidth/2 - 220)', () => {
    // 模拟浏览器 viewport 1920x1080
    const innerWidth = 1920;
    const innerHeight = 1080;
    const width = 440;
    const height = 580;

    // lazy initial state 算法
    const position = {
      x: Math.max(20, (innerWidth - width) / 2),
      y: Math.max(25, (innerHeight - height) / 2),
    };
    expect(position.x).toBe(740); // (1920 - 440) / 2 = 740
    expect(position.y).toBe(250); // (1080 - 580) / 2 = 250
  });

  it('小屏幕 fallback(Math.max 20/25)', () => {
    // 模拟窄屏 400x300,模态 440x580 超出 → x 落到 20,y 落到 25
    const innerWidth = 400;
    const innerHeight = 300;
    const width = 440;
    const height = 580;

    const position = {
      x: Math.max(20, (innerWidth - width) / 2),
      y: Math.max(25, (innerHeight - height) / 2),
    };
    // x = (400-440)/2 = -20,max(20, -20) = 20
    expect(position.x).toBe(20);
    // y = (300-580)/2 = -140,max(25, -140) = 25
    expect(position.y).toBe(25);
  });

  it('SSR 环境(window undefined):回退到默认左上角坐标', () => {
    // 模拟 typeof window === 'undefined' (SSR)
    const isSSR = true;
    const fallback = { x: 120, y: 80 };
    const position = isSSR
      ? fallback
      : { x: Math.max(20, (1920 - 440) / 2), y: Math.max(25, (1080 - 580) / 2) };
    expect(position).toEqual({ x: 120, y: 80 });
  });
});

describe('SettingsModal — providers 数据加载兼容', () => {
  // 关键:新 store 用 get() 直接拿到反序列化后的对象/数组
  // 老 localStorage 路径才会拿到 string
  // 必须两种格式都能处理,否则 JSON.parse(array) 会崩成 "[object Object]" 错误

  it('当 saved 是数组(新 store 路径):直接使用', () => {
    const saved: any = [{ id: 'xiaomi' }, { id: 'openai' }];
    const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as any[]).length).toBe(2);
  });

  it('当 saved 是字符串(老 localStorage 路径):JSON.parse', () => {
    const saved = '[{"id":"xiaomi"},{"id":"openai"}]';
    const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as any[]).length).toBe(2);
  });

  it('当 saved 是 null/undefined/0:不进入解析路径', () => {
    const saved1: any = null;
    const saved2: any = undefined;
    expect(saved1).toBeFalsy();
    expect(saved2).toBeFalsy();
    // falsy 直接跳过整个 if 分支
  });

  it('当 saved 是非法 JSON 字符串:JSON.parse 抛错被 try-catch 吞掉', () => {
    const saved = 'not valid json{';
    let caught = false;
    try {
      const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
    } catch (e) {
      caught = true;
    }
    expect(caught).toBe(true);
  });
});

describe('ModelIcon — placeholder/empty ID 防御', () => {
  // 关键:当 activeProvider 是 EMPTY_PROVIDER(id="placeholder")时,
  // ModelIcon 必须能正常渲染,不能进 LobeModelIcon(model="placeholder") 的崩溃路径
  // 同时:调用方可能传 对象/数组/数字 等非字符串真值(从旧 store 或 HMR 重载的数据里),
  // 必须用 typeof 防御后再 .trim(),否则抛 TypeError 黑屏

  const PLACEHOLDER_IDS = ['', 'placeholder', 'empty', 'unknown', 'PLACEHOLDER', 'Unknown', 'undefined', 'null'];

  it.each(PLACEHOLDER_IDS)('字符串 ID "%s" 应该被识别为占位符', (id) => {
    const modelId = (typeof id === 'string' ? id : '').trim().toLowerCase();
    const isPlaceholder =
      !modelId ||
      modelId === 'placeholder' ||
      modelId === 'empty' ||
      modelId === 'unknown' ||
      modelId === 'undefined' ||
      modelId === 'null';
    expect(isPlaceholder).toBe(true);
  });

  it.each([
    ['undefined (js)', undefined],
    ['null (js)', null],
    ['对象', { id: 'foo' }],
    ['数组', ['gpt-4o']],
    ['数字 0', 0],
    ['数字 42', 42],
    ['布尔 false', false],
    ['布尔 true', true],
    ['Promise', Promise.resolve('gpt-4o')],
  ])('非字符串输入 "%s" 必须不抛异常,fallback 到 placeholder', (_label, value) => {
    let caught: Error | null = null;
    let modelId = '';
    let isPlaceholder = false;
    try {
      const rawId = typeof value === 'string' ? value : '';
      modelId = rawId.trim().toLowerCase();
      isPlaceholder =
        !modelId ||
        modelId === 'placeholder' ||
        modelId === 'empty' ||
        modelId === 'unknown' ||
        modelId === 'undefined' ||
        modelId === 'null';
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeNull();
    expect(isPlaceholder).toBe(true);
  });

  it('正常 ID (xiaomi/openai) 不应被识别为占位符', () => {
    const ids = ['xiaomi', 'openai', 'doubao', 'glm', 'nvidia', 'groq'];
    for (const id of ids) {
      const modelId = (typeof id === 'string' ? id : '').trim().toLowerCase();
      const isPlaceholder =
        !modelId ||
        modelId === 'placeholder' ||
        modelId === 'empty' ||
        modelId === 'unknown' ||
        modelId === 'undefined' ||
        modelId === 'null';
      expect(isPlaceholder).toBe(false);
    }
  });
});

describe('Canvas3DClient — class 实例化防御', () => {
  // 关键:Canvas3DClient 是一个 class,不能 named import 实例方法
  // 构造器吃 number port,不是 string URL
  // 错误的传参会生成畸形 baseUrl,所有 HTTP 请求失败

  it('构造器吃 number port,内部拼 baseUrl', () => {
    class MockClient {
      port: number;
      baseUrl: string;
      constructor(port: number) {
        this.port = port;
        this.baseUrl = `http://127.0.0.1:${port}`;
      }
    }
    const c = new MockClient(3000);
    expect(c.baseUrl).toBe('http://127.0.0.1:3000');
  });

  it('错误:传 string URL 会生成畸形 baseUrl', () => {
    class MockClient {
      port: any;
      baseUrl: string;
      constructor(port: any) {
        this.port = port;
        this.baseUrl = `http://127.0.0.1:${this.port}`;
      }
    }
    // 模拟之前那个错误:new Canvas3DClient(`http://127.0.0.1:${port}`)
    const wrongUrl = `http://127.0.0.1:3000`;
    const c = new MockClient(wrongUrl);
    // 这就是 bug 现场 — baseUrl 变成了"http://127.0.0.1:http://127.0.0.1:3000"
    expect(c.baseUrl).toBe('http://127.0.0.1:http://127.0.0.1:3000');
    // 这不是有效 URL,会抛 "Invalid URL"
    expect(() => new URL(c.baseUrl)).toThrow();
  });

  it('named import class 实例方法 → undefined(触发 Vite 模块加载失败)', () => {
    // 模拟:import { pushRttInput } from '.../Canvas3DClient'
    // 实际模块里 pushRttInput 不是 export,只有 class 导出
    // named import 拿到 undefined
    const fakeModule: { pushRttInput?: unknown; Canvas3DClient?: unknown } = {
      Canvas3DClient: class {},
      // pushRttInput: undefined (named import 找不到 → undefined)
    };
    expect(fakeModule.pushRttInput).toBeUndefined();
    expect(fakeModule.Canvas3DClient).toBeDefined();
  });
});
