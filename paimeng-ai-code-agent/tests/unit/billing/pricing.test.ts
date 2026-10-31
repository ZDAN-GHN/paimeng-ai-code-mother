import { describe, expect, it } from 'vitest';
import { candidateRateKeys, priceSteps, resolveStepRate, type PricedStep, type RatedStep } from '@/server/billing/pricing';
import type { RateCardView } from '@/shared/billing';

/**
 * 计价接缝：纯函数、无数据库（docs/specs/credit-billing.md「Testing Decisions」第 2 条）。
 * 这里断言的规则全部来自 docs/specs/credit-billing.md 与 04-settlement-design.md §2：
 * 三类 token 分开乘、整数累加、总额层四舍五入一次、缓存与推理不重复计价、缺用量估算、缺费率为待处理。
 */

/** 只填计价关心的字段，其余按「成本未知」构造。 */
function rate(providerId: string, modelName: string, overrides: Partial<RateCardView> = {}): RateCardView {
  return {
    providerId,
    modelName,
    effectiveFrom: '2026-10-01 00:00:00.000',
    creditInputMiss: 600,
    creditInputHit: 12,
    creditOutput: 2500,
    usdInputMiss: null,
    usdInputHit: null,
    usdOutput: null,
    costBasis: null,
    costSource: null,
    note: null,
    createdBy: null,
    createTime: '2026-10-01 00:00:00.000',
    ...overrides,
  };
}

function step(overrides: Partial<PricedStep> = {}): PricedStep {
  return {
    stepId: null,
    providerId: 'env-default',
    modelName: 'deepseek-flash',
    upstreamModelId: null,
    at: '2026-10-15 08:00:00.000',
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: null,
    ...overrides,
  };
}

const flash = rate('env-default', 'deepseek-flash');

function rated(priced: PricedStep, stepRate: RateCardView | null = flash): RatedStep {
  return { step: priced, rate: stepRate };
}

describe('按步骤计价', () => {
  it('缓存未命中、命中、输出三类分开乘各自费率', () => {
    const result = priceSteps([rated(step({ input: 1_000_000, cacheRead: 2_000_000, output: 100_000 }))]);
    // 600 + 12×2 + 2500×0.1 = 874 Credit
    expect(result).toMatchObject({ credits: 874, status: 'settled', estimatedSteps: 0, unpricedSteps: 0 });
  });

  it('多个模型混排时各用各的费率，不在总额层之外取整', () => {
    const pro = rate('env-default', 'deepseek-v4-pro', { creditInputMiss: 2600, creditInputHit: 50, creditOutput: 8500 });
    const result = priceSteps([
      rated(step({ input: 333_333, cacheRead: 100_001, output: 7_777 })),
      rated(step({ modelName: 'deepseek-v4-pro', input: 100_001, cacheRead: 3_333, output: 999 }), pro),
    ]);
    // flash: (333333×600 + 100001×12 + 7777×2500) / 1e6 = 219.94…；pro: (100001×2600 + 3333×50 + 999×8500) / 1e6 = 268.71…
    const flashCredits = (333_333 * 600 + 100_001 * 12 + 7_777 * 2500) / 1e6;
    const proCredits = (100_001 * 2600 + 3_333 * 50 + 999 * 8500) / 1e6;
    expect(result.credits).toBe(Math.round(flashCredits + proCredits));
    // 逐步取整会得到另一个数：确认我们没有那样做
    expect(result.credits).not.toBe(Math.round(flashCredits) + Math.round(proCredits));
  });

  it('零 token 的步骤计价为零且状态仍是已结算', () => {
    expect(priceSteps([rated(step())])).toMatchObject({ credits: 0, status: 'settled', unpricedSteps: 0 });
  });

  it('只在总额层四舍五入一次：合计 0.5 Credit 进位，0.499999 舍去', () => {
    const unit = rate('env-default', 'unit', { creditInputMiss: 1, creditInputHit: 0, creditOutput: 0 });
    expect(priceSteps([rated(step({ input: 500_000 }), unit)]).credits).toBe(1);
    expect(priceSteps([rated(step({ input: 499_999 }), unit)]).credits).toBe(0);
    // 两个 0.25 相加进位到 1：逐步取整会得到 0
    const halves = priceSteps([rated(step({ input: 250_000 }), unit), rated(step({ input: 250_000 }), unit)]);
    expect(halves.credits).toBe(1);
  });

  it('cacheWrite 与 reasoning 不单独计价，input 也不再减一次缓存', () => {
    const result = priceSteps([rated(step({ cacheWrite: 9_000_000, reasoning: 9_000_000 }))]);
    expect(result.credits).toBe(0);
    // input 已经是「未命中输入」（上游 usage.input 已排除 cacheRead/cacheWrite），不再做减法
    const mixed = priceSteps([rated(step({ input: 1_000_000, cacheRead: 1_000_000, output: 0 }))]);
    expect(mixed.credits).toBe(612);
  });

  it('没有任何模型步骤时是零金额的已结算账单', () => {
    expect(priceSteps([])).toMatchObject({ credits: 0, status: 'settled', estimatedSteps: 0, unpricedSteps: 0, steps: [] });
  });
});

describe('费率未命中的步骤', () => {
  it('单步查不到费率时整单待处理，不按零计费', () => {
    const result = priceSteps([rated(step({ input: 1_000_000 }), null)]);
    expect(result).toMatchObject({ credits: 0, status: 'unpriced', unpricedSteps: 1, estimatedSteps: 0 });
    expect(result.steps[0]).toMatchObject({ priced: false, estimated: false, rate: null });
  });

  it('部分步骤有费率时状态是部分待处理，已定价的部分照实入账', () => {
    const result = priceSteps([
      rated(step({ input: 1_000_000 })),
      rated(step({ modelName: 'unknown-model' }), null),
    ]);
    expect(result).toMatchObject({ credits: 600, status: 'partial', unpricedSteps: 1 });
  });
});

describe('用量缺失时的估算', () => {
  it('按同一次生成已知步骤的分量均值估算，再用缺失步骤自己的费率计价', () => {
    const pro = rate('env-default', 'deepseek-v4-pro', { creditInputMiss: 2600, creditInputHit: 50, creditOutput: 8500 });
    const result = priceSteps([
      rated(step({ input: 1_000, cacheRead: 200, output: 400 })),
      rated(step({ modelName: 'deepseek-v4-pro', input: 3_000, cacheRead: 400, output: 800 }), pro),
      rated(step({ modelName: 'deepseek-v4-pro', input: null, cacheRead: null, output: null }), pro),
    ]);
    expect(result).toMatchObject({ status: 'estimated', estimatedSteps: 1, unpricedSteps: 0 });
    const estimatedStep = result.steps[2];
    expect(estimatedStep).toMatchObject({ estimated: true, sampleSteps: 2, billedInput: 2_000, billedCacheRead: 300, billedOutput: 600 });
    // 原始用量保持为空：估算只影响计价，不伪造上报值
    expect(estimatedStep).toMatchObject({ input: null, cacheRead: null, output: null });
    const expected = (1_000 * 600 + 200 * 12 + 400 * 2500 + 3_000 * 2600 + 400 * 50 + 800 * 8500 + 2_000 * 2600 + 300 * 50 + 600 * 8500) / 1e6;
    expect(result.credits).toBe(Math.round(expected));
  });

  it('没有任何已知样本时该步不可估算，计入待处理', () => {
    const result = priceSteps([rated(step({ input: null, cacheRead: null, output: null }))]);
    expect(result).toMatchObject({ credits: 0, status: 'unpriced', estimatedSteps: 0, unpricedSteps: 1 });
    expect(result.steps[0]).toMatchObject({ estimated: false, sampleSteps: 0, priced: false });
  });

  it('缺用量又没有费率时仍是待处理，不重复计数', () => {
    const result = priceSteps([rated(step({ input: null, output: null }), null)]);
    expect(result).toMatchObject({ status: 'unpriced', unpricedSteps: 1, estimatedSteps: 0 });
  });
});

describe('USD 成本', () => {
  it('上游成本未知时是 null，不拿售价折算', () => {
    expect(priceSteps([rated(step({ input: 1_000_000 }))]).costUsd).toBeNull();
  });

  it('三档 USD 费率都已知时按整数累计后输出 6 位定点字符串', () => {
    const priced = rate('env-default', 'deepseek-flash', {
      usdInputMiss: '0.300000', usdInputHit: '0.006000', usdOutput: '1.200000',
    });
    // 1000×0.3/1e6 + 2000×0.006/1e6 + 500×1.2/1e6 = 0.000912 USD
    const result = priceSteps([rated(step({ input: 1_000, cacheRead: 2_000, output: 500 }), priced)]);
    expect(result.costUsd).toBe('0.000912');
  });

  it('某一步缺 USD 费率时该步不贡献成本，但其他步骤照常累计', () => {
    const withUsd = rate('env-default', 'deepseek-flash', {
      usdInputMiss: '1.000000', usdInputHit: '0.000000', usdOutput: '0.000000',
    });
    const result = priceSteps([
      rated(step({ input: 1_000_000 }), withUsd),
      rated(step({ input: 1_000_000 }), rate('env-default', 'plain')),
    ]);
    expect(result.costUsd).toBe('1.000000');
  });
});

describe('费率候选键', () => {
  it('按固定顺序给出四组候选并去重', () => {
    expect(candidateRateKeys({
      providerId: 'deepseek#a1b2c3d4', modelName: 'deepseek-flash', upstreamModelId: 'deepseek-flash-2026',
    })).toEqual([
      { providerId: 'deepseek#a1b2c3d4', modelName: 'deepseek-flash' },
      { providerId: 'deepseek', modelName: 'deepseek-flash' },
      { providerId: 'deepseek#a1b2c3d4', modelName: 'deepseek-flash-2026' },
      { providerId: 'deepseek', modelName: 'deepseek-flash-2026' },
    ]);
  });

  it('没有 # 后缀或上游模型名相同时不产生重复候选', () => {
    expect(candidateRateKeys({ providerId: 'env-default', modelName: 'deepseek-flash', upstreamModelId: null }))
      .toEqual([{ providerId: 'env-default', modelName: 'deepseek-flash' }]);
    expect(candidateRateKeys({ providerId: 'env-default', modelName: 'deepseek-flash', upstreamModelId: 'deepseek-flash' }))
      .toEqual([{ providerId: 'env-default', modelName: 'deepseek-flash' }]);
  });

  it('身份全空时没有候选，解析结果为空', () => {
    expect(candidateRateKeys({ providerId: null, modelName: null, upstreamModelId: null })).toEqual([]);
    expect(resolveStepRate([flash], step({ providerId: null, modelName: null }))).toBeNull();
  });

  it('第一个命中的候选即生效：先按 provider+model，再退回上游模型名', () => {
    const rates = [
      rate('deepseek', 'deepseek-flash-2026', { creditInputMiss: 700 }),
      rate('deepseek', 'deepseek-flash', { creditInputMiss: 800 }),
    ];
    // provider 带 # 后缀、模型名是别名：第 2 个候选命中
    const stepWithAlias = step({ providerId: 'deepseek#a1b2c3d4', modelName: 'deepseek-flash' });
    expect(resolveStepRate(rates, stepWithAlias)).toMatchObject({ providerId: 'deepseek', modelName: 'deepseek-flash' });
    // 别名没建费率时退回上游模型名（第 4 个候选）
    expect(resolveStepRate(rates, step({ providerId: 'deepseek#a1b2c3d4', modelName: 'alias-only', upstreamModelId: 'deepseek-flash-2026' })))
      .toMatchObject({ modelName: 'deepseek-flash-2026' });
  });

  it('每一步按自己的 create_time 解析当时有效的版本', () => {
    const rates = [
      rate('env-default', 'deepseek-flash', { effectiveFrom: '2026-10-01 00:00:00.000', creditInputMiss: 600 }),
      rate('env-default', 'deepseek-flash', { effectiveFrom: '2026-11-01 00:00:00.000', creditInputMiss: 900 }),
    ];
    expect(resolveStepRate(rates, step({ at: '2026-10-15 00:00:00.000' }))?.creditInputMiss).toBe(600);
    expect(resolveStepRate(rates, step({ at: '2026-11-15 00:00:00.000' }))?.creditInputMiss).toBe(900);
  });
});

describe('费率快照', () => {
  it('只记录本次实际用到的费率版本，并按首次使用顺序去重', () => {
    const pro = rate('env-default', 'deepseek-v4-pro');
    const result = priceSteps([
      rated(step({ input: 1 })),
      rated(step({ modelName: 'deepseek-v4-pro', input: 1 }), pro),
      rated(step({ input: 1 })),
      rated(step({ modelName: 'no-rate' }), null),
    ]);
    expect(result.rates.map(item => `${item.providerId}/${item.modelName}`)).toEqual([
      'env-default/deepseek-flash',
      'env-default/deepseek-v4-pro',
    ]);
  });
});

describe('逐步骤金额（补结算用）', () => {
  it('stepCredits 与 steps 一一对应，未定价步骤记 0，取整只发生在总额层', () => {
    const result = priceSteps([
      rated(step({ input: 1_000_000 })),
      rated(step({ input: 1, output: 1 })),
      rated(step({ modelName: 'no-rate' }), null),
    ]);
    expect(result.stepCredits).toHaveLength(3);
    // 分子 = token × 费率，不做除法；1M × 600 = 6e8，第二个步骤是 1 × 600 + 1 × 2500 = 3100
    expect(result.stepCredits[0]).toBe(600_000_000);
    expect(result.stepCredits[1]).toBe(3_100);
    expect(result.stepCredits[2]).toBe(0);
    // 只在总额层四舍五入一次：(6e8 + 3100) / 1e6 = 600.0031 → 600
    expect(result.credits).toBe(600);
    expect(result.steps[2]).toMatchObject({ priced: false, rate: null });
  });

  it('快照带上步骤身份：同一 generation_step 在补结算里只计一次', () => {
    const result = priceSteps([rated(step({ stepId: '42', input: 1_000_000 }))]);
    expect(result.steps[0]).toMatchObject({ stepId: '42', priced: true });
  });
});
