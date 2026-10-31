'use client';
import { useCallback, useEffect, useState } from 'react';
import { App } from 'antd';
import { api } from '@/client/api';
import { useAuth } from '@/components/providers';
import { formatBeijingTime } from '@/shared/display';
import { monthlyQuotaCredits, poolLabels, type AccountSummary } from '@/shared/billing';
import styles from './credit-balance.module.css';

/**
 * 额度条：Owner 自己的双池余额、本期配额的有效期、近 60 天购买额与透支线。
 * 永远只读自己的——管理员看他人余额走 92 的 admin/billing/usage，这里不接受 userId。
 * `refreshToken` 变化时重取，用来在发放或结算之后刷新。
 */
export function CreditBalance({ refreshToken }: { refreshToken?: string }) {
  const { user } = useAuth();
  const { message } = App.useApp();
  const [summary, setSummary] = useState<AccountSummary | null>(null);

  const load = useCallback(async () => {
    try {
      setSummary(await api<AccountSummary>('billing/summary'));
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [message]);

  useEffect(() => {
    if (!user) {
      setSummary(null);
      return;
    }
    void load();
  }, [user, load, refreshToken]);

  if (!user || !summary) return null;
  return <section className={styles.creditBalance} aria-label="我的 Credit 概览">
    <p className={styles.pools}>
      <span>{poolLabels.quota}<strong>{summary.quota}</strong></span>
      <span aria-hidden="true">·</span>
      <span>{poolLabels.balance}<strong>{summary.balance}</strong></span>
      <span aria-hidden="true">·</span>
      <span>合计<strong>{summary.total}</strong></span>
    </p>
    <p className={styles.detail}>
      <span>{`本期配额 ${monthlyQuotaCredits} Credit，有效期至北京时间 ${formatBeijingTime(summary.quotaExpiresAt)}`}</span>
      <span aria-hidden="true">·</span>
      <span>月底清零，不累积、不折现</span>
    </p>
    <p className={styles.detail}>
      <span>{poolLabels.balance}不随账期重置</span>
      <span aria-hidden="true">·</span>
      <span>透支线 {summary.overdraft} Credit</span>
      <span aria-hidden="true">·</span>
      <span>近 60 天购买 {summary.purchasedCredits60d} Credit</span>
    </p>
  </section>;
}
