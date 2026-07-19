/**
 * Garnet 客户端
 * Garnet 是微软研究院开发的高性能内存数据库，Redis 兼容
 * 按文档设计: Garnet 作为热数据层，不存储持久数据
 */

import Redis from 'ioredis';

// 默认连接配置
const DEFAULT_CONFIG = {
  host: process.env.GARNET_HOST || 'localhost',
  port: parseInt(process.env.GARNET_PORT || '6379', 10),
  password: process.env.GARNET_PASSWORD,
  db: parseInt(process.env.GARNET_DB || '0', 10),
  retryStrategy: (times: number) => {
    if (times > 10) {
      console.error('[Garnet] Max retry attempts reached');
      return null;
    }
    return Math.min(times * 100, 3000);
  },
  reconnectOnError: (err: Error) => {
    // 可重连的错误类型白名单
    const reconnectableErrors = [
      'READONLY',      // Redis 集群只读模式
      'ECONNRESET',    // 连接被对端重置
      'ECONNREFUSED',  // 连接被拒绝（Garnet 进程重启中）
      'ETIMEDOUT',     // 连接超时
      'ENOTFOUND',     // DNS 解析失败
    ];

    const code = (err as NodeJS.ErrnoException).code;
    for (const target of reconnectableErrors) {
      if (err.message.includes(target) || code === target) {
        return true;
      }
    }

    console.warn('[Garnet] Non-reconnectable error:', code, err.message);
    return false;
  },
};

// 默认客户端实例
let garnet: Redis | null = null;

// 补偿队列专用客户端
let compensationClient: Redis | null = null;

/**
 * 获取默认客户端实例
 */
export function getClient(): Redis {
  if (!garnet) {
    garnet = new Redis(DEFAULT_CONFIG);

    garnet.on('connect', () => {
      console.log('[Garnet] Connected to', DEFAULT_CONFIG.host + ':' + DEFAULT_CONFIG.port);
    });

    garnet.on('error', (err) => {
      console.error('[Garnet] Error:', err.message);
    });

    garnet.on('close', () => {
      console.log('[Garnet] Connection closed');
    });
  }

  return garnet;
}

/**
 * 获取补偿队列专用客户端
 * 分离连接避免主流程被阻塞
 */
export function getCompensationClient(): Redis {
  if (!compensationClient) {
    compensationClient = new Redis({
      ...DEFAULT_CONFIG,
      maxRetriesPerRequest: null, // 补偿队列可以无限重试
    });

    // Prevent Node.js from crashing on unhandled 'error' events
    compensationClient.on('error', (err) => {
      console.error('[Garnet] Compensation client error:', err.message);
    });
  }
  return compensationClient;
}

/**
 * 连接数据库
 */
export async function connect(): Promise<void> {
  const client = getClient();
  await client.ping();
  console.log('[Garnet] Connection verified');
}

/**
 * 断开连接
 */
export async function disconnect(): Promise<void> {
  if (garnet) {
    await garnet.quit();
    garnet = null;
    console.log('[Garnet] Main client disconnected');
  }
  if (compensationClient) {
    await compensationClient.quit();
    compensationClient = null;
    console.log('[Garnet] Compensation client disconnected');
  }
}

/**
 * 健康检查
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const client = getClient();
    const result = await client.ping();
    return result === 'PONG';
  } catch (error) {
    console.error('[Garnet] Health check failed:', error);
    return false;
  }
}

// 导出默认客户端实例
export default { getClient, getCompensationClient, connect, disconnect, healthCheck };
