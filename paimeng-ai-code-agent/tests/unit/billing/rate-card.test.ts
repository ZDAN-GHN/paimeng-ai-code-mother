import { describe, expect, it } from 'vitest';
import { resolveRate, SELL_UNIT, validateRateInput } from '@/server/billing/rate-card';
import { creditDenominationLabel, rateCardUnitLabel, type RateCardView } from '@/shared/billing';

/** 只填费率解析关心的字段，其余按「成本未知」构造，避免每个用例重复 12 个字段。 */
function rate(providerId: string, modelName: string, effectiveFrom: string, creditInputMiss = 600): RateCardView {
  return {
    providerId,
    modelName,
    effectiveFrom,
    creditInputMiss,
    creditInputHit: 12,
    creditOutput: 2500,
    usdInputMiss: null,
    usdInputHit: null,
    usdOutput: null,
    costBasis: null,
    costSource: null,
    note: null,
    createdBy: null,
    createTime: effectiveFrom,
  };
}

const rates: RateCardView[] = [
  rate('env-default', 'deepseek-flash', '2026-10-01 00:00:00.000'),
  rate('env-default', 'deepseek-flash', '2026-11-01 00:00:00.000', 900),
  rate('env-default', 'deepseek-v4-pro', '2026-10-01 00:00:00.000', 2600),
  rate('durable', 'deepseek-flash', '2026-10-01 00:00:00.000', 700),
];

describe('按步骤时刻解析费率', () => {
  it('取步骤时刻之前最新的版本', () => {
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-10-15 08:00:00.000')?.creditInputMiss).toBe(600);
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-11-15 08:00:00.000')?.creditInputMiss).toBe(900);
  });

  it('未来版本不得提前生效', () => {
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-10-31 23:59:59.999')?.creditInputMiss).toBe(600);
  });

  it('生效时刻本身算生效，毫秒缺省不影响边界', () => {
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-11-01 00:00:00.000')?.creditInputMiss).toBe(900);
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-10-01 00:00:00')?.creditInputMiss).toBe(600);
  });

  it('早于最早版本时返回未定价', () => {
    expect(resolveRate(rates, 'env-default', 'deepseek-flash', '2026-09-30 23:59:59.999')).toBeNull();
  });

  it('提供商与模型名一起参与匹配，不串号', () => {
    expect(resolveRate(rates, 'env-default', 'deepseek-v4-pro', '2026-10-15 00:00:00.000')?.creditInputMiss).toBe(2600);
    expect(resolveRate(rates, 'durable', 'deepseek-flash', '2026-10-15 00:00:00.000')?.creditInputMiss).toBe(700);
    expect(resolveRate(rates, 'env-default', 'gpt-4o', '2026-10-15 00:00:00.000')).toBeNull();
    expect(resolveRate(rates, 'fixture', 'deepseek-flash', '2026-10-15 00:00:00.000')).toBeNull();
  });

  it('步骤缺少提供商或模型时返回未定价，不回退到任何常量', () => {
    expect(resolveRate(rates, null, 'deepseek-flash', '2026-10-15 00:00:00.000')).toBeNull();
    expect(resolveRate(rates, 'env-default', null, '2026-10-15 00:00:00.000')).toBeNull();
  });

  it('空费率表返回未定价', () => {
    expect(resolveRate([], 'env-default', 'deepseek-flash', '2026-10-15 00:00:00.000')).toBeNull();
  });
});

describe('费率输入校验', () => {
  const valid = {
    providerId: 'env-default',
    modelName: 'deepseek-flash',
    effectiveFrom: '2026-12-01 00:00:00.000',
    creditInputMiss: 600,
    creditInputHit: 12,
    creditOutput: 2500,
  };

  it('接受完整费率并保留空白的成本字段为 null', () => {
    expect(validateRateInput(valid)).toEqual({
      providerId: 'env-default',
      modelName: 'deepseek-flash',
      effectiveFrom: '2026-12-01 00:00:00.000',
      creditInputMiss: 600,
      creditInputHit: 12,
      creditOutput: 2500,
      usdInputMiss: null,
      usdInputHit: null,
      usdOutput: null,
      costBasis: null,
      costSource: null,
      note: null,
    });
  });

  it('拒绝负费率', () => {
    expect(() => validateRateInput({ ...valid, creditOutput: -1 })).toThrow(/费率不能是负数/u);
  });

  it('拒绝三个费率全为零', () => {
    expect(() => validateRateInput({ ...valid, creditInputMiss: 0, creditInputHit: 0, creditOutput: 0 })).toThrow(/不能同时为 0/u);
  });

  it('拒绝非法生效时间', () => {
    expect(() => validateRateInput({ ...valid, effectiveFrom: '2026-13-01 00:00:00' })).toThrow(/不是合法时刻/u);
    expect(() => validateRateInput({ ...valid, effectiveFrom: '下周一' })).toThrow(/生效时间必须形如/u);
  });

  it('保留成本未知，也接受最多 6 位小数的上游成本', () => {
    expect(validateRateInput({ ...valid, usdInputMiss: '0.3', costBasis: 'peak' })).toMatchObject({
      usdInputMiss: '0.3',
      costBasis: 'peak',
    });
    expect(() => validateRateInput({ ...valid, usdOutput: '0.1234567' })).toThrow(/最多 6 位小数/u);
  });
});

describe('Credit 面额', () => {
  it('1 Credit = ¥0.01 是固定面额', () => {
    expect(SELL_UNIT).toEqual({ creditPerYuan: 100, tokensPerMillion: 1_000_000 });
    expect(creditDenominationLabel).toBe('1 Credit = ¥0.01');
    expect(rateCardUnitLabel).toBe('Credit / 1M tokens');
  });
});
