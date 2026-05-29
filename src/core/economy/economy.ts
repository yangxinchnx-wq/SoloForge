// ─────────────────────────────────────────────────────────────────
// SoloForge Economy Layer: Economic System (经济系统)
// Path: src/core/economy/economy.ts
// Description: 信用经济系统，控制资源分配和成本感知决策
// ─────────────────────────────────────────────────────────────────

import { ulid } from 'ulid';

export interface CreditTransaction {
  id: string;
  agentId: string;
  type: 'income' | 'spending';
  amount: number;
  category: string;
  description: string;
  timestamp: number;
  balance: number;  // 交易后余额
}

export interface AgentEconomy {
  id: string;
  agentId: string;
  credits: number;               // 当前信用分
  spending: Record<string, number>;  // 消费明细
  income: Record<string, number>;    // 收入明细
  balance: number;              // 余额
  quota: {
    hourly: number;
    daily: number;
  };
  usage: {
    hourlyUsed: number;
    dailyUsed: number;
    lastReset: number;
  };
  createdAt: number;
  updatedAt: number;
}

export interface MarketResource {
  id: string;
  resource: string;              // 资源名称
  demand: number;               // 当前需求
  supply: number;                // 当前供给
  cost: number;                  // 单位成本
  allocation: 'competitive' | 'priority' | 'fair';
  priceHistory: number[];        // 价格历史
  updatedAt: number;
}

/**
 * 经济系统管理器
 */
export class EconomyManager {
  private economies: Map<string, AgentEconomy> = new Map();
  private transactions: Map<string, CreditTransaction[]> = new Map();
  private markets: Map<string, MarketResource> = new Map();
  private readonly DEFAULT_HOURLY_QUOTA = 1000;
  private readonly DEFAULT_DAILY_QUOTA = 10000;

  constructor() {
    this.initializeDefaultResources();
  }

  /**
   * 初始化默认资源市场
   */
  private initializeDefaultResources(): void {
    this.createMarket({
      resource: 'claude_api',
      supply: 1000,
      cost: 0.15,
      allocation: 'competitive'
    });

    this.createMarket({
      resource: 'qwen_api',
      supply: 5000,
      cost: 0.02,
      allocation: 'fair'
    });

    this.createMarket({
      resource: 'deepseek_api',
      supply: 3000,
      cost: 0.01,
      allocation: 'fair'
    });

    this.createMarket({
      resource: 'local_compute',
      supply: 10000,
      cost: 0,
      allocation: 'priority'
    });
  }

  /**
   * 创建市场资源
   */
  public createMarket(data: {
    resource: string;
    supply: number;
    cost: number;
    allocation: 'competitive' | 'priority' | 'fair';
  }): MarketResource {
    const id = `market_${data.resource}`;
    const now = Date.now();

    const market: MarketResource = {
      id,
      resource: data.resource,
      demand: 0,
      supply: data.supply,
      cost: data.cost,
      allocation: data.allocation,
      priceHistory: [data.cost],
      updatedAt: now
    };

    this.markets.set(id, market);
    return market;
  }

  /**
   * 注册 Agent 经济账户
   */
  public registerAccount(agentId: string, initialCredits = 1000): AgentEconomy {
    const existing = this.economies.get(agentId);
    if (existing) return existing;

    const id = `economy_${ulid()}`;
    const now = Date.now();

    const economy: AgentEconomy = {
      id,
      agentId,
      credits: initialCredits,
      spending: {},
      income: {},
      balance: initialCredits,
      quota: {
        hourly: this.DEFAULT_HOURLY_QUOTA,
        daily: this.DEFAULT_DAILY_QUOTA
      },
      usage: {
        hourlyUsed: 0,
        dailyUsed: 0,
        lastReset: now
      },
      createdAt: now,
      updatedAt: now
    };

    this.economies.set(agentId, economy);
    this.transactions.set(agentId, []);

    console.log(`[Economy] 注册账户: ${agentId} (初始余额: ${initialCredits})`);

    return economy;
  }

  /**
   * 消费信用
   */
  public spend(
    agentId: string,
    amount: number,
    category: string,
    description: string
  ): { success: boolean; transaction?: CreditTransaction } {
    let economy = this.economies.get(agentId);
    if (!economy) {
      economy = this.registerAccount(agentId);
    }

    // 检查配额
    this.resetUsageIfNeeded(economy);
    if (economy.usage.hourlyUsed + amount > economy.quota.hourly) {
      console.warn(`[Economy] ${agentId} 超过小时配额`);
      return { success: false };
    }

    if (economy.usage.dailyUsed + amount > economy.quota.daily) {
      console.warn(`[Economy] ${agentId} 超过日配额`);
      return { success: false };
    }

    if (economy.balance < amount) {
      console.warn(`[Economy] ${agentId} 余额不足`);
      return { success: false };
    }

    // 执行消费
    economy.balance -= amount;
    economy.usage.hourlyUsed += amount;
    economy.usage.dailyUsed += amount;
    economy.spending[category] = (economy.spending[category] || 0) + amount;
    economy.updatedAt = Date.now();

    // 记录交易
    const transaction: CreditTransaction = {
      id: `tx_${ulid()}`,
      agentId,
      type: 'spending',
      amount,
      category,
      description,
      timestamp: Date.now(),
      balance: economy.balance
    };

    this.transactions.get(agentId)!.push(transaction);
    this.updateMarketDemand(category, amount);

    return { success: true, transaction };
  }

  /**
   * 收入信用
   */
  public earn(
    agentId: string,
    amount: number,
    category: string,
    description: string
  ): CreditTransaction {
    let economy = this.economies.get(agentId);
    if (!economy) {
      economy = this.registerAccount(agentId);
    }

    economy.balance += amount;
    economy.credits += amount;
    economy.income[category] = (economy.income[category] || 0) + amount;
    economy.updatedAt = Date.now();

    // 记录交易
    const transaction: CreditTransaction = {
      id: `tx_${ulid()}`,
      agentId,
      type: 'income',
      amount,
      category,
      description,
      timestamp: Date.now(),
      balance: economy.balance
    };

    this.transactions.get(agentId)!.push(transaction);

    return transaction;
  }

  /**
   * 重置用量（如果需要）
   */
  private resetUsageIfNeeded(economy: AgentEconomy): void {
    const now = Date.now();
    const hourMs = 3600000;
    const dayMs = 86400000;

    if (now - economy.usage.lastReset > hourMs) {
      economy.usage.hourlyUsed = 0;
    }

    if (now - economy.usage.lastReset > dayMs) {
      economy.usage.dailyUsed = 0;
      economy.usage.hourlyUsed = 0;
      economy.usage.lastReset = now;
    }
  }

  /**
   * 更新市场需求的动态价格
   */
  private updateMarketDemand(resource: string, amount: number): void {
    const market = this.markets.get(`market_${resource}`);
    if (!market) return;

    market.demand += amount;

    // 动态价格调整（供不应求时涨价）
    if (market.demand > market.supply) {
      market.cost *= 1.1;  // 涨价 10%
      market.cost = Math.min(market.cost, market.cost * 2);  // 最高翻倍
    } else {
      market.cost *= 0.98;  // 降价 2%
      market.cost = Math.max(market.cost, market.priceHistory[0] * 0.5);  // 最低五折
    }

    market.priceHistory.push(market.cost);
    if (market.priceHistory.length > 100) {
      market.priceHistory = market.priceHistory.slice(-100);
    }

    market.updatedAt = Date.now();
  }

  /**
   * 获取资源推荐（基于余额和价格）
   */
  public getResourceRecommendation(agentId: string): {
    resource: string;
    cost: number;
    reason: string;
  } {
    const economy = this.economies.get(agentId);
    const balance = economy?.balance || 100;

    const markets = Array.from(this.markets.values())
      .filter(m => m.cost <= balance * 0.1);  // 消费不超过余额的 10%

    if (markets.length === 0) {
      // 使用免费资源
      return {
        resource: 'local_compute',
        cost: 0,
        reason: '余额不足，使用免费本地计算资源'
      };
    }

    // 选择最高效的资源
    const best = markets.reduce((a, b) => a.cost <= b.cost ? a : b);

    return {
      resource: best.resource,
      cost: best.cost,
      reason: `基于成本效益分析，选择 ${best.resource} (成本: ${best.cost})`
    };
  }

  /**
   * 获取账户
   */
  public getAccount(agentId: string): AgentEconomy | undefined {
    return this.economies.get(agentId);
  }

  /**
   * 获取交易历史
   */
  public getTransactions(agentId: string, limit = 50): CreditTransaction[] {
    const txs = this.transactions.get(agentId) || [];
    return txs.slice(-limit);
  }

  /**
   * 获取市场信息
   */
  public getMarket(resource: string): MarketResource | undefined {
    return this.markets.get(`market_${resource}`);
  }

  /**
   * 获取所有市场
   */
  public getAllMarkets(): MarketResource[] {
    return Array.from(this.markets.values());
  }

  /**
   * 分配资源（基于信誉）
   */
  public allocateResource(
    resource: string,
    requestAmount: number,
    reputationScore: number
  ): { allocated: number; price: number } {
    const market = this.markets.get(`market_${resource}`);
    if (!market) return { allocated: 0, price: 0 };

    let allocated = 0;

    if (market.allocation === 'competitive') {
      // 竞争性分配：高信誉优先
      allocated = Math.min(requestAmount, market.supply);
    } else if (market.allocation === 'priority') {
      // 优先级分配：直接分配
      allocated = Math.min(requestAmount, market.supply);
    } else {
      // 公平分配：按比例
      allocated = Math.min(requestAmount, market.supply * 0.5);
    }

    return {
      allocated,
      price: market.cost * allocated
    };
  }

  /**
   * 获取经济统计
   */
  public stats(): {
    totalAccounts: number;
    totalCredits: number;
    averageBalance: number;
    marketCount: number;
    totalDemand: number;
  } {
    const economies = Array.from(this.economies.values());

    return {
      totalAccounts: economies.length,
      totalCredits: economies.reduce((sum, e) => sum + e.credits, 0),
      averageBalance: economies.length > 0
        ? economies.reduce((sum, e) => sum + e.balance, 0) / economies.length
        : 0,
      marketCount: this.markets.size,
      totalDemand: Array.from(this.markets.values())
        .reduce((sum, m) => sum + m.demand, 0)
    };
  }
}

// 导出单例
export const economyManager = new EconomyManager();
export default economyManager;
