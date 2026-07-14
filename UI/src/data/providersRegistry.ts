// =====================================================
// 云端模型服务商共享类型定义
// 从 SettingsModal.tsx 抽出，供 ModelAddTab / ProviderCard 共享
//
// 设计原则：模型列表不预置，全部由 /api/providers/scan-models
// 从上游 LLM 服务实时扫描获取。
// =====================================================

/** 模型元数据 — 从上游 API + 本地知识库归一化后的统一格式 */
export interface ModelMetadata {
  /** 上下文窗口大小 (tokens) */
  contextWindow?: number;
  /** 最大输出 tokens */
  maxOutput?: number;
  /** 输入模态 */
  inputModalities?: string[];
  /** 输出模态 */
  outputModalities?: string[];
  /** 是否支持 function calling / tools */
  supportsTools?: boolean;
  /** 是否支持 JSON mode */
  supportsJson?: boolean;
  /** 是否支持流式输出 */
  supportsStreaming?: boolean;
  /** 是否支持视觉 (image 输入) */
  supportsVision?: boolean;
  /** 模型所有者/发布者 */
  owner?: string;
  /** 创建时间戳 (Unix) */
  created?: number;
  /** 模型描述 */
  description?: string;
  /** 输入价格 (每 1M tokens, 美元) */
  pricingInput?: number;
  /** 输出价格 (每 1M tokens, 美元) */
  pricingOutput?: number;
  /** 架构类型 (如 transformer / MoE) */
  architecture?: string;
  /** 参数量 (如 7B / 72B) */
  parameters?: string;
  /** 上游返回的原始字段 (未归一化, 供调试/展示) */
  raw?: Record<string, unknown>;
}

export interface ModelProvider {
  id: string;
  name: string;
  desc: string;
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  defaultUrl: string;
  models: { id: string; name: string; enabled: boolean; metadata?: ModelMetadata }[];
  customModels: string[];
  status: 'idle' | 'loading' | 'success' | 'failed';
  delay?: number;
  errorMessage?: string;
  color: string;
  scanned?: boolean;
  /**
   * 模型级连通性测试结果: modelId → success(boolean)
   * 由「测试连通性」按钮触发 /api/providers/test-batch 返回,
   * 随 providers 一起持久化到 localStorage, 供 Header 过滤主模型选择器。
   * undefined = 尚未测试; {} = 已测试但无模型数据
   */
  probeResults?: Record<string, boolean>;
  /**
   * 图标类型:
   *   - undefined / 'auto': 自动匹配 @lobehub/icons (按 provider.id 或 model 名)
   *   - 'animal:<id>': 用内置动物头像 (cat/dog/fox/panda/owl/penguin/lion/tiger/rabbit/bear/frog/whale/butterfly/bird/hamster/hedgehog/raccoon/turtle/octopus/koala)
   *   - 'custom:<dataUrl>': 用户上传的自定义图标 (data:image/png;base64,...)
   */
  iconType?: string;
}

// 云端模型扫描结果
export interface CloudModelScanResult {
  success: boolean;
  providerName: string;
  discoveredModels: { id: string; name: string; metadata?: ModelMetadata }[];
  error?: string;
  latency?: number;
}

/** 探针实测结果 — 通过发送真实 API 请求探测模型能力 */
export interface ProbeResult {
  success: boolean;
  modelId: string;
  /** 总探测耗时 (ms) */
  latency: number;
  /** 实测能力 (null = 探测失败/不确定) */
  probed: {
    /** 基础对话是否可用 */
    basic: boolean;
    /** 视觉 (图片输入) */
    vision: boolean | null;
    /** Function Calling / Tools */
    tools: boolean | null;
    /** JSON Mode */
    json: boolean | null;
    /** 流式输出 */
    streaming: boolean | null;
    /** Embeddings 向量嵌入 */
    embeddings: boolean | null;
  };
  /** 从错误信息中解析出的限制 */
  limits: {
    contextWindow: number | null;
    maxOutput: number | null;
  };
  /** ping 响应中的 token usage */
  usage: Record<string, unknown> | null;
  /** 模型定价信息 (OpenRouter 格式) */
  pricing: Record<string, unknown> | null;
  /** /models/{id} 完整原始数据 */
  rawModelInfo: Record<string, unknown> | null;
  /** ping 响应头 (含限流信息) */
  responseHeaders: Record<string, string>;
  /** 基础 ping 的完整响应体 */
  pingResponse: Record<string, unknown> | null;
  /** 从 /models/{id} 获取的服务器信息 */
  serverInfo: Record<string, unknown>;
  /** 各探测项的错误详情 */
  errors: Record<string, string>;
}

// 消息连接通道诊断日志
export interface ChannelTestLog {
  time: string;
  type: 'info' | 'success' | 'error';
  text: string;
}
