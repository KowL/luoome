import { describe, expect, it } from 'bun:test';

import {
  buildAccountSnapshotInput,
  quotePriceFromResult,
  snapshotButtonLabel,
  snapshotErrorText,
  snapshotStatusNotice,
  toolErrorText,
} from './holdings-actions.js';

describe('新增持仓行情价格', () => {
  it('从 fetch_quote 的 data.quote.close 中读取现价', () => {
    expect(
      quotePriceFromResult({
        ok: true,
        data: { quote: { close: 12.34 } },
      }),
    ).toBe(12.34);
  });

  it('失败或非法价格不回填', () => {
    expect(quotePriceFromResult({ ok: false, error: { kind: 'adapter_error' } })).toBeNull();
    expect(quotePriceFromResult({ ok: true, data: { quote: { close: 0 } } })).toBeNull();
  });
});

describe('持仓写操作错误提示', () => {
  it('permission_denied 显示服务端原因', () => {
    expect(
      toolErrorText({
        kind: 'permission_denied',
        required: 'write/external 操作未开启',
      }),
    ).toBe('权限校验失败：write/external 操作未开启');
  });
});

describe('账户快照输入校验', () => {
  const position = {
    stockId: '600519.SH',
    quantity: 100,
    availableQuantity: 100,
    marketValue: 60000,
  };

  it('complete 必须提供现金余额', () => {
    expect(buildAccountSnapshotInput({ status: 'complete', positions: [] })).toEqual({
      error: '「完整」快照必须填写现金余额；只更新了持仓请选「待核对」',
    });
    expect(
      buildAccountSnapshotInput({ status: 'complete', cashBalance: 40000, positions: [position] }),
    ).toEqual({
      input: {
        status: 'complete',
        cashBalance: 40000,
        positions: [position],
      },
    });
  });

  it('现金为非法数字时给出可读提示，而不是当成缺失', () => {
    expect(
      buildAccountSnapshotInput({ status: 'complete', cashBalance: Number.NaN, positions: [] }),
    ).toEqual({ error: '现金余额必须是非负数字' });
    expect(
      buildAccountSnapshotInput({ status: 'complete', cashBalance: -1, positions: [] }),
    ).toEqual({ error: '现金余额必须是非负数字' });
  });

  it('needs-reconciliation 允许缺省现金但保留已填现金', () => {
    expect(
      buildAccountSnapshotInput({ status: 'needs-reconciliation', positions: [position] }),
    ).toEqual({ input: { status: 'needs-reconciliation', positions: [position] } });
    expect(
      buildAccountSnapshotInput({
        status: 'needs-reconciliation',
        cashBalance: 500,
        positions: [position],
      }).input,
    ).toMatchObject({ cashBalance: 500 });
  });

  it('unavailable 不写入现金，只保留持仓数量事实', () => {
    expect(
      buildAccountSnapshotInput({
        status: 'unavailable',
        cashBalance: 40000,
        positions: [position],
      }).input,
    ).toEqual({ status: 'unavailable', positions: [position] });
  });

  it('逐行拒绝缺股票、非法数量、可卖超过数量与非法市值', () => {
    expect(
      buildAccountSnapshotInput({ cashBalance: 1, positions: [{ ...position, stockId: '' }] }),
    ).toEqual({ error: '第 1 行：请先选择股票或输入完整带后缀代码' });
    expect(
      buildAccountSnapshotInput({ cashBalance: 1, positions: [{ ...position, quantity: 1.5 }] }),
    ).toEqual({ error: '第 1 行：数量必须是非负整数' });
    expect(
      buildAccountSnapshotInput({
        cashBalance: 1,
        positions: [{ ...position, quantity: 100, availableQuantity: 200 }],
      }),
    ).toEqual({ error: '第 1 行：可卖数量必须是不超过数量的非负整数' });
    expect(
      buildAccountSnapshotInput({ cashBalance: 1, positions: [{ ...position, marketValue: -1 }] }),
    ).toEqual({ error: '第 1 行：市值必须是非负数字' });
  });

  it('备注去空白，空备注不写入', () => {
    expect(buildAccountSnapshotInput({ cashBalance: 1, note: '   ', positions: [] }).input).toEqual(
      { status: 'complete', cashBalance: 1, positions: [] },
    );
    expect(
      buildAccountSnapshotInput({ cashBalance: 1, note: ' 已核对 ', positions: [] }).input,
    ).toMatchObject({ note: '已核对' });
  });
});

describe('账户快照错误提示', () => {
  it('未入库标的给出可执行的下一步', () => {
    expect(snapshotErrorText({ kind: 'not_found', entity: 'Stock', id: '999999.SH' })).toBe(
      '股票 999999.SH 不在股票目录中：请先在「持仓」页用「+ 新增持仓」登记后重试',
    );
  });

  it('其它错误沿用通用 tool 错误文案', () => {
    expect(snapshotErrorText({ kind: 'invalid_input', message: '快照不合法' })).toContain(
      '快照不合法',
    );
  });
});

describe('账户快照状态文案', () => {
  it('缺失 / 待核对 / 不可用各自给出明确后果，完整时不占位', () => {
    expect(snapshotStatusNotice(undefined)?.title).toBe('尚未登记账户快照');
    expect(snapshotStatusNotice({ version: 3, status: 'needs-reconciliation' })?.detail).toContain(
      '精确仓位与当前可执行建仓建议已暂停',
    );
    expect(snapshotStatusNotice({ version: 2, status: 'unavailable' })?.detail).toContain(
      '无法计算仓位与组合预算',
    );
    expect(snapshotStatusNotice({ version: 1, status: 'complete' })).toBeNull();
  });

  it('按钮文案跟随状态：登记 / 核对并保存 / 更新', () => {
    expect(snapshotButtonLabel(undefined)).toBe('登记账户快照');
    expect(snapshotButtonLabel({ status: 'needs-reconciliation' })).toBe('核对并保存快照');
    expect(snapshotButtonLabel({ status: 'unavailable' })).toBe('核对并保存快照');
    expect(snapshotButtonLabel({ status: 'complete' })).toBe('更新账户快照');
  });
});
