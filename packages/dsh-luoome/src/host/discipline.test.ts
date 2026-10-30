// luoome 全局纪律段测试（T11b）。
//
// 三组断言：
// 1) 七条约束与已删除的 `packages/dsh-bridge/src/standalone-prompt.ts` 逐字一致 —— 源文件在
//    M2-02 随独立 MCP 形态删除，因此把原文写成测试内常量 `ARCHIVED_DISCIPLINE_CONSTRAINTS`
//    做对账；任何改写、精简或换序都会让这条测试变红。
// 2) `section()` 只调用一次，参数为 `{name:'luoome:discipline', order:-10000, interpolate:false}`，
//    `text` 是 7 条编号列表（编号 1..7 与顺序都在断言里）。
// 3) dispose 撤销 section（fake ctx 记录调用），重复 dispose 幂等且可重新注册；
//    另用真实 DSH SystemPrompt registry 验证装配顺序与撤销效果。
import { Context } from '@deepseek-ai/cordis';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { describe, expect, it } from 'vitest';
import {
  type DisciplineContext,
  formatDisciplineText,
  LUOOME_DISCIPLINE_CONSTRAINTS,
  LUOOME_DISCIPLINE_ORDER,
  LUOOME_DISCIPLINE_SECTION,
  registerDiscipline,
} from './discipline.js';

// 逐字原文，取自 `git show HEAD:packages/dsh-bridge/src/standalone-prompt.ts`
// （该文件已在 M2-02 随 dsh-bridge 一起删除；本常量是仓库内仅存的对照副本）。
const ARCHIVED_DISCIPLINE_CONSTRAINTS: readonly string[] = [
  '谈具体标的时先取事实再下结论，不要凭记忆报价格、涨跌幅或财报数字；取不到就直说取不到。',
  '`advice` 不等于 `trade`；没有下单能力，永远不说「已买入/已卖出」；给出的是带条件的建议与观察计划。',
  '引用建议时保留反证、风险、免责声明和有效期；`confidence` 是模型信心度，不是概率，更不是确定性。',
  '区分 `StrategySignal`、`Advice` 和成交记录，不要把信号说成建议，也不要把建议说成已执行。',
  '讨论「要不要买」时，先给反面证据，再给结论，最后给可证伪的观察条件（价位、量能、失效条件）。',
  '侧栏面板与工具是同一份数据；聊天里读到的，面板会同步显示。',
  'luoome 的批处理由 DSH 定时任务调度：涉及 luoome 定时任务时先读 luoome-batch 技能，不要自己起常驻调度进程或用 shell 轮询。',
];

interface FakeSectionContext {
  readonly ctx: DisciplineContext;
  readonly calls: PromptSection[];
  readonly revoked: string[];
}

/** fake ctx：记录 `section()` 的入参与注册返回的撤销函数是否被调用。 */
const createFakeContext = (): FakeSectionContext => {
  const calls: PromptSection[] = [];
  const revoked: string[] = [];
  const ctx: DisciplineContext = {
    systemPrompt: {
      section: (section) => {
        calls.push(section);
        return () => {
          revoked.push(section.name);
        };
      },
    },
  };
  return { ctx, calls, revoked };
};

describe('luoome 全局纪律段', () => {
  it('七条约束与已删除的 standalone-prompt.ts 逐字一致', () => {
    expect(LUOOME_DISCIPLINE_CONSTRAINTS).toHaveLength(7);
    expect([...LUOOME_DISCIPLINE_CONSTRAINTS]).toEqual([...ARCHIVED_DISCIPLINE_CONSTRAINTS]);
    // 逐条再比一次：数组级相等已覆盖，但单条断言能让 diff 直接指向被改写的那一条。
    ARCHIVED_DISCIPLINE_CONSTRAINTS.forEach((archived, index) => {
      expect(LUOOME_DISCIPLINE_CONSTRAINTS[index], `第 ${String(index + 1)} 条被改写`).toBe(
        archived,
      );
    });
  });

  it('section() 只调用一次，参数与排序固定，text 含 7 条编号', () => {
    const fake = createFakeContext();
    registerDiscipline(fake.ctx);

    expect(fake.calls).toHaveLength(1);
    const section = fake.calls[0] as PromptSection;
    expect(section.name).toBe('luoome:discipline');
    expect(section.name).toBe(LUOOME_DISCIPLINE_SECTION);
    expect(section.order).toBe(-10000);
    expect(section.order).toBe(LUOOME_DISCIPLINE_ORDER);
    expect(section.interpolate).toBe(false);

    const text = section.text as string;
    expect(text).toBe(formatDisciplineText(ARCHIVED_DISCIPLINE_CONSTRAINTS));
    expect(text.split('\n')).toHaveLength(7);
    ARCHIVED_DISCIPLINE_CONSTRAINTS.forEach((line, index) => {
      expect(text).toContain(`${String(index + 1)}. ${line}`);
    });
    // 纪律段远早于 DSH 的身份段（-1000）与 persona/tool 段（>=0）。
    expect(section.order).toBeLessThan(-1000);
  });

  it('dispose 撤销 section；重复 dispose 幂等且可重新注册', () => {
    const fake = createFakeContext();
    const dispose = registerDiscipline(fake.ctx);
    expect(fake.revoked).toEqual([]);

    dispose();
    expect(fake.revoked).toEqual([LUOOME_DISCIPLINE_SECTION]);

    // 幂等：第二次 dispose 不会再撤销一次（否则会撤掉别人重注册的段）。
    dispose();
    expect(fake.revoked).toEqual([LUOOME_DISCIPLINE_SECTION]);

    // 插件重复 apply 的等价路径：撤销后可以重新注册，仍然只新增一次注册。
    const again = registerDiscipline(fake.ctx);
    expect(fake.calls).toHaveLength(2);
    again();
    expect(fake.revoked).toEqual([LUOOME_DISCIPLINE_SECTION, LUOOME_DISCIPLINE_SECTION]);
  });

  it('缺少 systemPrompt 服务时拒绝装配（fail-loud）', () => {
    expect(() => registerDiscipline({} as unknown as DisciplineContext)).toThrow(
      /systemPrompt 服务/,
    );
    expect(() =>
      registerDiscipline({
        systemPrompt: {
          section: () => {
            throw new Error('duplicate section');
          },
        },
      }),
    ).toThrow(/纪律段注册失败: duplicate section/);
  });

  it('真实 SystemPrompt registry：排在身份段之前，按插件 fiber 的 effect 撤销', async () => {
    const ctx = new Context();
    new SystemPrompt(ctx, {});

    // 与 plugin.apply 的接线方式一致：注册动作包在 effect 里，disposer 归 fiber 所有。
    const disposeEffect = ctx.effect(() => registerDiscipline(ctx));
    const registered = await ctx.systemPrompt.assemble();
    const names = registered.sections.map((section) => section.name);
    expect(names[0]).toBe(LUOOME_DISCIPLINE_SECTION);
    expect(names).toContain('harness:identity');
    expect(registered.sections[0]?.text).toBe(
      formatDisciplineText(ARCHIVED_DISCIPLINE_CONSTRAINTS),
    );
    expect(registered.sections[0]?.interpolate).toBe(false);

    // 宿主 dispose 插件 → effect 撤销 → 纪律段消失；DSH 自带段不受影响。
    await disposeEffect();
    const afterDispose = await ctx.systemPrompt.assemble();
    expect(afterDispose.sections.map((section) => section.name)).not.toContain(
      LUOOME_DISCIPLINE_SECTION,
    );
    expect(afterDispose.sections.map((section) => section.name)).toContain('harness:identity');
  });
});
