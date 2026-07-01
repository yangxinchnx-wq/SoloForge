// -*- coding: utf-8 -*-
// src/api-server.analytics.test.ts
// SoloForge API Server — DuckDB Analytics 端到端测试 (2026-07-02)
//
// 验证 SoloForgeApiServer 类内 5 个 DuckDB handler 都能产出正确响应：
//   - handleAnalyticsHealth
//   - handleAnalyticsQueries
//   - handleAnalyticsRun
//   - handleAnalyticsDirect
//   - handleAnalyticsSnapshot
//   - handleAnalyticsParquet
//
// 不起 3001 端口（避免依赖 Garnet/SurrealDB/kernel 整栈），用 (svc as any) 强转
// 访问 private handler。duckdb.exe 与 ai_society.db 必须存在；否则 SKIP。

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SoloForgeApiServer } from './api-server';

const DUCKDB_BIN = path.resolve(process.cwd(), 'bin', 'duckdb', 'duckdb.exe');
const SQLITE_PATH = path.resolve(process.cwd(), 'python', 'data', 'ai_society', 'ai_society.db');

const HAS_DEPS = fs.existsSync(DUCKDB_BIN) && fs.existsSync(SQLITE_PATH);

// 最小 kernel mock：只满足构造和 DuckDB handler 的访问
function makeFakeKernel(): any {
  return {
    state: 'READY',
    version: 1,
    currentTick: 0,
    startedAt: Date.now(),
    eventBus: { getEventLog: () => [] },
    components: new Map(),
  };
}

describe('SoloForgeApiServer.ANALYTICS_QUERIES', () => {
  it('应定义 4 个内置查询模板', () => {
    const queries = (SoloForgeApiServer as any).ANALYTICS_QUERIES;
    expect(Object.keys(queries).sort()).toEqual([
      'governance_summary',
      'law_violation_by_type',
      'memory_table_counts',
      'top_institutions',
    ]);
    for (const [name, spec] of Object.entries(queries)) {
      expect((spec as any).sql).toMatch(/^SELECT/i);
      expect((spec as any).description.length).toBeGreaterThan(0);
    }
  });
});

describe('SoloForgeApiServer.ANALYTICS_SNAPSHOT_TABLES (whitelist)', () => {
  it('应包含 14 张业务表（与 init_ai_society.py 对齐）', () => {
    const tables = (SoloForgeApiServer as any).ANALYTICS_SNAPSHOT_TABLES;
    expect(tables.length).toBe(14);
    // 业务核心 9 张
    expect(tables).toContain('institution');
    expect(tables).toContain('governance');
    expect(tables).toContain('reputation');
    expect(tables).toContain('culture');
    expect(tables).toContain('economy');
    expect(tables).toContain('law');
    expect(tables).toContain('law_violation');
    expect(tables).toContain('coalition');
    expect(tables).toContain('social_memory');
    // 业务记录 5 张
    expect(tables).toContain('credit_transaction');
    expect(tables).toContain('economy_record');
    expect(tables).toContain('governance_record');
    expect(tables).toContain('reputation_record');
    expect(tables).toContain('reputation_sync_log');
  });

  it('不应包含不存在的表 (agent/cluster/memory/event/transaction)', () => {
    const tables = (SoloForgeApiServer as any).ANALYTICS_SNAPSHOT_TABLES;
    expect(tables).not.toContain('agent');
    expect(tables).not.toContain('cluster');
    expect(tables).not.toContain('memory');
    expect(tables).not.toContain('event');
    expect(tables).not.toContain('transaction');
  });
});

describe.skipIf(!HAS_DEPS)('DuckDB Analytics Handlers (e2e)', () => {
  let svc: SoloForgeApiServer;
  let tmpDir: string;

  beforeAll(() => {
    svc = new SoloForgeApiServer(makeFakeKernel() as any, undefined, undefined, 3091);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-api-test-'));
  });

  it('handleAnalyticsHealth: 探活返回 duckdb + sqlite + 4 queries', () => {
    const r = (svc as any).handleAnalyticsHealth();
    expect(r.status).toBe(200);
    expect(r.body.duckdb_available).toBe(true);
    expect(r.body.duckdb_binary).toContain('duckdb.exe');
    expect(r.body.duckdb_version).toMatch(/^v\d+\.\d+\.\d+/);
    expect(r.body.sqlite_exists).toBe(true);
    expect(r.body.queries_defined).toContain('memory_table_counts');
    expect(r.body.snapshot_tables.length).toBeGreaterThan(5);
  });

  it('handleAnalyticsQueries: 列出 4 个查询', () => {
    const r = (svc as any).handleAnalyticsQueries();
    expect(r.status).toBe(200);
    expect(r.body.queries.length).toBe(4);
    const names = r.body.queries.map((q: any) => q.name);
    expect(names).toContain('memory_table_counts');
  });

  it('handleAnalyticsRun(memory_table_counts): 跑出 13 行表计数', () => {
    const r = (svc as any).handleAnalyticsRun('memory_table_counts');
    expect(r.status).toBe(200);
    expect(r.body.query_name).toBe('memory_table_counts');
    expect(r.body.row_count).toBe(13);
    // rows 第一行是 header 'table_name,row_count'
    expect(r.body.rows[0]).toEqual(['table_name', 'row_count']);
    expect(r.body.elapsed_ms).toBeGreaterThan(0);
  });

  it('handleAnalyticsRun(unknown): 返回 404', () => {
    const r = (svc as any).handleAnalyticsRun('no_such_query');
    expect(r.status).toBe(404);
    expect(r.body.error).toContain('Unknown query');
  });

  it('handleAnalyticsDirect(SELECT): 跑任意 SQL', () => {
    const r = (svc as any).handleAnalyticsDirect({ sql: 'SELECT COUNT(*) AS n FROM db.main.culture' });
    expect(r.status).toBe(200);
    expect(r.body.row_count).toBeGreaterThanOrEqual(0);
    // CSV first row header, data row at index 1
    if (r.body.row_count > 0) {
      expect(r.body.rows[1]).toEqual(['4']);
    }
  });

  it('handleAnalyticsDirect(无 sql): 返回 400', () => {
    const r = (svc as any).handleAnalyticsDirect({});
    expect(r.status).toBe(400);
  });

  it('handleAnalyticsDirect(DROP): 拒绝破坏性语句', () => {
    const r = (svc as any).handleAnalyticsDirect({ sql: 'DROP TABLE culture' });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain('destructive');
  });

  it('handleAnalyticsSnapshot: 抽 3 张表到 .duckdb', () => {
    const out = path.join(tmpDir, 'snap.duckdb');
    const r = (svc as any).handleAnalyticsSnapshot({
      out_path: out,
      tables: ['law', 'coalition', 'reputation_record'],
    });
    expect(r.status).toBe(200);
    expect(r.body.out_path).toBe(out);
    expect(r.body.tables_exported.length).toBe(3);
    expect(fs.existsSync(out)).toBe(true);
    expect(r.body.size_bytes).toBeGreaterThan(0);
    // 行数累加应等于单表之和
    const sum = r.body.tables_exported.reduce((s: number, t: any) => s + t.row_count, 0);
    expect(r.body.total_rows).toBe(sum);
  });

  it('handleAnalyticsSnapshot(非白名单表名): 返回 400', () => {
    const r = (svc as any).handleAnalyticsSnapshot({
      out_path: path.join(tmpDir, 'bad.duckdb'),
      tables: ['culture', 'evil_table'],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('whitelist');
  });

  it('handleAnalyticsDirect(CAST AS INTEGER): 自动转 TRY_CAST 不 500', () => {
    // 2026-07-02 修复: SQLite VARCHAR 列 CAST AS INTEGER 会 500, 应自动转 TRY_CAST 返回 NULL
    // priority 列是 BIGINT (SQLite INTEGER 推断), CAST 应 OK; 用 culture.intensity 测类型不匹配场景
    const r = (svc as any).handleAnalyticsDirect({
      sql: 'SELECT name, CAST(priority AS INTEGER) AS p_int FROM db.main.institution ORDER BY p_int DESC LIMIT 3',
    });
    expect(r.status).toBe(200);
    expect(r.body.cast_transformed).toBe(true);
    expect(r.body.row_count).toBe(3);
  });

  it('handleAnalyticsDirect(TRY_CAST): 已是 TRY_CAST 则不再转换', () => {
    const r = (svc as any).handleAnalyticsDirect({
      sql: 'SELECT TRY_CAST(priority AS VARCHAR) FROM db.main.institution LIMIT 1',
    });
    expect(r.status).toBe(200);
    expect(r.body.cast_transformed).toBe(false);
  });

  it('handleAnalyticsSnapshot(institution 白名单表): 应该成功', () => {
    // 2026-07-02 修复: institution 不在旧白名单, 现在应允许
    const out = path.join(tmpDir, 'institution.duckdb');
    const r = (svc as any).handleAnalyticsSnapshot({
      out_path: out,
      tables: ['institution', 'culture', 'economy'],
    });
    expect(r.status).toBe(200);
    expect(r.body.tables_exported.length).toBe(3);
    const names = r.body.tables_exported.map((t: any) => t.table);
    expect(names).toContain('institution');
  });

  it('handleAnalyticsParquet: 导出 2 张表为 .parquet', () => {
    const outDir = path.join(tmpDir, 'parquet_out');
    const r = (svc as any).handleAnalyticsParquet({
      out_dir: outDir,
      tables: ['law', 'coalition'],
    });
    expect(r.status).toBe(200);
    expect(r.body.out_dir).toBe(outDir);
    expect(r.body.files.length).toBe(2);
    for (const f of r.body.files) {
      expect(fs.existsSync(f.path)).toBe(true);
      expect(f.size_bytes).toBeGreaterThan(0);
    }
    // 临时 .duckdb 应被清理
    expect(fs.existsSync(path.join(outDir, '_snapshot.duckdb'))).toBe(false);
  });
});
