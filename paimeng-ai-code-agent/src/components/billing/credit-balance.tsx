'use client';
import { useCallback, useEffect, useState } from 'react';
import { App } from 'antd';
import { api } from '@/client/api';
import { useAuth } from '@/components/providers';
import { poolLabels, type AccountSnapshot } from '@/shared/billing';
import styles from './credit-balance.module.css';

/**
 * 额度条：Owner 自己的双池余额、近 60 天购买额与透支线。
 * 永远只读自己的——管理员看他人余额走 92 的 admin/billing/usage，这里不接受 userId。
 * `refreshToken` 变化时重取，用来在发放或结算之后刷新。
 */
export function CreditBalance({ refreshToken }: { refreshToken?: string }) {
  const { user } = useAuth();
  const { message } = App.useApp();
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await api<AccountSnapshot>('billing/summary'));
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [message]);

  useEffect(() => {
    if (!user) {
      setSnapshot(null);
      return;
    }
    void load();
  }, [user, load, refreshToken]);

  if (!user || !snapshot) return null;
  return <section className={styles.creditBalance} aria-label="我的 Credit 额度">
    <p className={styles.pools}>
      <span>{poolLabels.quota}<strong>{snapshot.quota}</strong></span>
      <span aria-hidden="true">·</span>
      <span>{poolLabels.balance}<strong>{snapshot.balance}</strong></span>
      <span aria-hidden="true">·</span>
      <span>合计<strong>{snapshot.total}</strong></span>
    </p>
    <p className={styles.detail}>
      <span>透支线 {snapshot.overdraft} Credit</span>
      <span aria-hidden="true">·</span>
      <span>近 60 天购买 {snapshot.purchasedCredits60d} Credit</span>
    </p>
  </section>;
}
