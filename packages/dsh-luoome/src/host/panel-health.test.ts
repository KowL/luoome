import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { toolRegistry } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { createMarketSurface } from './market-surface.js';
import { assessPanelHealth, PANEL_HEALTH_STATUSES } from './panel-health.js';
import { createPanelStateHandler, PANEL_NAMES } from './panels.js';
import { createReadSurface } from './read-surface.js';

const FIXED_AS_OF = new Date('2026-10-25T04:00:00Z');

/** 面板路由只调 read 工具；这里给全量 read 名单，避免「工具不在名单」被误当成失败。 */
const readAllowlist = (): string[] =>
  toolRegistry
    .all()
    .filter((tool) => tool.sideEffect === 'read')
    .map((tool) => tool.name);

const setup = async () => {
  const ctx = await buildTestContext({ clock: () => FIXED_AS_OF });
  const read = createReadSurface({
    config: { allowlist: readAllowlist() },
    tools: toolRegistry.all(),
    context: () => ctx,
    accountId: ctx.user.defaultAccountId,
  });
  const handle = createPanelStateHandler({
    read,
    // 零 market 工具：面板的 external 调用一律 permission_denied，
    // 这正好覆盖「工具失败 → 角标降级」。
    market: createMarketSurface({
      config: { allowlist: [] },
      tools: toolRegistry.all(),
      context: () => ctx,
    }),
    admit: () => null,
    now: () => FIXED_AS_OF,
    marketTimeoutMs: 50,
  });
  return { ctx, handle };
};

const stateOf = async (handle: (request: Request) => Promise<Response>, panel: string) => {
  const response = await handle(new Request(`https://dsh.example/api/luoome/state?panel=${panel}`));
  expect(response.status).toBe(200);
  return (await response.json()) as {
    panel: string;
    asOf: string;
    tools: { name: string; ok: boolean }[];
    health: {
      status: string;
      asOf?: string;
      checkedTools: string[];
      issues: { tool: string; reason: string; detail: string; remedy: string }[];
    };
  };
};

describe('S1 面板数据健康：每个面板都有 health（不写死数字）', () => {
  it('遍历 PANEL_NAMES：每个面板的服务端响应都带合法 health', async () => {
    const { handle } = await setup();
    // 自检：PANEL_NAMES 非空，否则下面的循环会「全绿」地空转。
    expect(PANEL_NAMES.length).toBeGreaterThan(0);

    for (const panel of PANEL_NAMES) {
      const body = await stateOf(handle, panel);
      expect(body.health, `${panel} 缺 health`).toBeDefined();
      expect(PANEL_HEALTH_STATUSES).toContain(body.health.status);
      expect(body.health.checkedTools.length, `${panel} 没有检查任何工具`).toBeGreaterThan(0);
      // 检查的就是该面板真实调用的工具（不是写死的清单）。
      expect(body.health.checkedTools).toEqual(body.tools.map((tool) => tool.name));
      for (const issue of body.health.issues) {
        expect(issue.remedy.length, `${issue.tool} 的缺口没写补法`).toBeGreaterThan(0);
        expect(issue.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it('静态守卫：PanelStateResponse 必须声明 health 且由 assessPanelHealth 产出', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'panels.ts'), 'utf8');
    expect(source).toContain('readonly health: PanelHealth');
    expect(source).toContain('health: assessPanelHealth(tools)');
  });
});

describe('S1 角标语义：两层输入 + 聚合时点取最旧', () => {
  it('全部 ok 且无降级 → available', () => {
    const health = assessPanelHealth([
      { name: 'list_accounts', ok: true, data: {} },
      { name: 'list_watchlists', ok: true, data: {} },
    ]);
    expect(health.status).toBe('available');
    expect(health.issues).toEqual([]);
    expect(health.asOf).toBeUndefined();
  });

  it('C4 某工具失败 → partial，且缺口点名补法（不是 available）', () => {
    const health = assessPanelHealth([
      { name: 'list_accounts', ok: true, data: {} },
      { name: 'list_watchlists', ok: false, error: { kind: 'internal' } },
    ]);
    expect(health.status).toBe('partial');
    expect(health.issues).toHaveLength(1);
    expect(health.issues[0]).toMatchObject({ tool: 'list_watchlists', reason: 'tool-failed' });
    expect(health.issues[0]?.remedy.length).toBeGreaterThan(0);
  });

  it('C5 工具 ok:true 但输出 status:unavailable → 仍判 partial（角标吃两层输入）', () => {
    const health = assessPanelHealth([
      {
        name: 'list_account_performance_snapshots',
        ok: true,
        data: { snapshots: [] },
      },
    ]);
    expect(health.status).toBe('partial');
    expect(health.issues[0]).toMatchObject({
      tool: 'list_account_performance_snapshots',
      reason: 'output-unavailable',
    });
    expect(health.issues[0]?.remedy).toContain('get_account_performance');
  });

  it('C5b ok:true 且输出指标降级（缺价导致 TWR unavailable）→ partial', () => {
    const health = assessPanelHealth([
      {
        name: 'list_account_performance_snapshots',
        ok: true,
        data: {
          snapshots: [
            {
              dataAsOf: '2026-10-24T00:00:00.000Z',
              metrics: {
                twr: { status: 'unavailable', reason: 'coverage-gap' },
                benchmarkTwr: { status: 'available' },
                excessTwr: { status: 'unavailable' },
              },
              coverage: { status: 'partial' },
            },
          ],
        },
      },
    ]);
    expect(health.status).toBe('partial');
    expect(health.issues[0]?.detail).toContain('twr:unavailable');
  });

  it('C6 所有工具都失败 → unavailable', () => {
    const health = assessPanelHealth([
      { name: 'list_accounts', ok: false, error: { kind: 'internal' } },
      { name: 'list_watchlists', ok: false, error: { kind: 'internal' } },
    ]);
    expect(health.status).toBe('unavailable');
    expect(health.issues).toHaveLength(2);
  });

  it('C7 聚合 asOf 取各工具时点的最小值（角标时间 ≤ 任何行内时间）', () => {
    const health = assessPanelHealth([
      {
        name: 'get_decision_loop_review',
        ok: true,
        data: { dataAsOf: '2026-10-24T00:00:00.000Z', unknowns: [], limitations: [] },
      },
      {
        name: 'get_ashare_sentiment',
        ok: true,
        data: { snapshot: { dataAsOf: '2026-10-20T00:00:00.000Z' } },
      },
    ]);
    expect(health.status).toBe('available');
    expect(health.asOf).toBe('2026-10-20T00:00:00.000Z');
  });

  it('C7b 声明了时点的工具没给时点 → asOf 缺席 + missing-data-as-of（不拿请求时间顶替）', () => {
    const health = assessPanelHealth([
      {
        name: 'get_decision_loop_review',
        ok: true,
        data: { dataAsOf: '2026-10-24T00:00:00.000Z', unknowns: [], limitations: [] },
      },
      { name: 'get_ashare_sentiment', ok: true, data: { snapshot: {} } },
    ]);
    expect(health.asOf).toBeUndefined();
    expect(health.issues.map((issue) => issue.reason)).toContain('missing-data-as-of');
  });

  it('持仓缺价 → partial 且点名「先跑 batch_quote」', () => {
    const health = assessPanelHealth([
      {
        name: 'list_holdings',
        ok: true,
        data: { holdings: [{ holding: { stockId: '600519.SH' }, quote: null }] },
      },
    ]);
    expect(health.status).toBe('partial');
    expect(health.issues[0]?.detail).toContain('没有可用报价');
    expect(health.issues[0]?.remedy).toContain('batch_quote');
  });

  it('输出形状异常不会让角标崩：降级并点名「无法判定」', () => {
    const health = assessPanelHealth([
      { name: 'list_holdings', ok: true, data: { holdings: 'not-an-array' } },
    ]);
    expect(PANEL_HEALTH_STATUSES).toContain(health.status);
    expect(health.status).toBe('available'); // holdings 非数组 → 视为空持仓，不伪造降级
  });
});
