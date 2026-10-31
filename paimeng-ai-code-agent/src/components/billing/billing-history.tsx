'use client';
import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, Select, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import Link from 'next/link';
import { api } from '@/client/api';
import { useAuth } from '@/components/providers';
import { stopReasonLabels } from '@/components/chat/generation-usage';
import {
  chargeStatusColors, chargeStatusLabels, creditDenominationLabel, poolLabels,
  type BillingChargeView, type ChargeStatus,
} from '@/shared/billing';
import type { AppInfo, Page } from '@/shared/contracts';
import { formatStoredTime } from '@/shared/display';
import { CreditBalance } from './credit-balance';
import styles from './billing-history.module.css';

/** 服务端一次最多返回 20 条：账单页只展示最近的，不做分页。 */
const chargeLimit = 20;

function splitOf(entries: { pool: keyof typeof poolLabels; credits: number }[], sign: 1 | -1): string {
  return entries
    .filter(entry => entry.credits * sign > 0)
    .map(entry => `${poolLabels[entry.pool]} ${Math.abs(entry.credits)}`)
    .join(' + ');
}

/**
 * Owner 查账（92）：自己的双池 Credit balance + 最近账单。
 * 金额一律显示有效金额（Σ entries）：「原扣多少 / 退了多少 / 分哪个池」都来自服务端的分录投影，
 * 界面不自己相加，也不把示例金额说成「还能生成几次」的承诺。
 */
export function BillingHistory() {
  const { user, loading } = useAuth();
  const { message } = App.useApp();
  const [charges, setCharges] = useState<BillingChargeView[]>([]);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [appId, setAppId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  const load = useCallback(async (scope?: string) => {
    setBusy(true);
    try {
      const query = `billing/charges?limit=${chargeLimit}` + (scope ? `&appId=${encodeURIComponent(scope)}` : '');
      setCharges(await api<BillingChargeView[]>(query));
      setRevision(value => value + 1);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [message]);

  useEffect(() => {
    if (!user) {
      setCharges([]);
      setApps([]);
      return;
    }
    void load(appId);
  }, [user, appId, load]);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const page = await api<Page<AppInfo>>('app/my/list/page/vo', { pageNum: 1, pageSize: 20 });
        setApps(page.records);
      } catch {
        // 应用列表只用于筛选：拉不到就退化成「全部应用」，不挡账单本身。
        setApps([]);
      }
    })();
  }, [user]);

  const appNameOf = (id: string) => apps.find(app => app.id === id)?.appName ?? id;

  const columns: ColumnsType<BillingChargeView> = [
    { title: '时间', dataIndex: 'createTime', width: 170, render: value => formatStoredTime(value) },
    {
      title: '应用',
      dataIndex: 'appId',
      width: 180,
      render: (id: string, charge) => <span>{charge.appName ?? appNameOf(id)}<span className={styles.mono}>{id}</span></span>,
    },
    { title: 'Generation', dataIndex: 'generationId', width: 220, render: (id: string) => <span className={styles.mono}>{id}</span> },
    {
      title: 'Credit（有效金额）',
      dataIndex: 'effectiveCredits',
      width: 240,
      render: (credits: number, charge) => {
        const charged = splitOf(charge.entries, 1);
        const refunded = splitOf(charge.reversals, -1);
        return <div className={styles.detail}>
          <strong>{credits} Credit</strong>
          {credits !== charge.credits && <span>原扣 {charge.credits} Credit</span>}
          {charged && <span>扣除：{charged}</span>}
          {refunded && <span>退还：{refunded}</span>}
        </div>;
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 200,
      render: (_: ChargeStatus, charge) => <div className={styles.tags}>
        <Tag color={chargeStatusColors[charge.status]}>{chargeStatusLabels[charge.status]}</Tag>
        {charge.estimated && <Tag color="orange">估算</Tag>}
        {charge.unpriced && <Tag>未定价</Tag>}
      </div>,
    },
    {
      title: '结束原因',
      dataIndex: 'stopReason',
      width: 140,
      render: (reason: BillingChargeView['stopReason']) => reason ? stopReasonLabels[reason] : '—',
    },
  ];

  if (loading) return <main className="page-container"><p>正在加载账单…</p></main>;
  if (!user) {
    return <main className="page-container">
      <div className={styles.login}>
        <Empty description="登录后可查看自己的 Credit 与账单" />
        <Link href="/user/login?redirect=%2Fbilling"><Button type="primary">去登录</Button></Link>
      </div>
    </main>;
  }

  return <main className="page-container">
    <div className="toolbar">
      <h1>我的账单</h1>
      <Button onClick={() => { void load(appId); }} loading={busy}>刷新</Button>
    </div>
    <CreditBalance refreshToken={String(revision)} />
    <section className={styles.panel} aria-label="最近账单">
      <div className={styles.filters}>
        <Select
          aria-label="按应用筛选"
          allowClear
          placeholder="全部应用"
          style={{ width: 260, maxWidth: '100%' }}
          value={appId}
          onChange={(value?: string) => setAppId(value)}
          options={apps.map(app => ({ value: app.id, label: app.appName ?? app.id }))}
        />
        <span className={styles.hint}>最多显示最近 {chargeLimit} 笔</span>
      </div>
      <Table
        rowKey="generationId"
        size="small"
        loading={busy}
        columns={columns}
        dataSource={charges}
        pagination={false}
        scroll={{ x: 1180 }}
        locale={{ emptyText: '还没有账单：每次生成结束后，这里会出现该次的消耗' }}
      />
      <p className={styles.hint}>
        金额按账本净额（有效金额）展示；冲正过的账单显示 0 Credit 并列出退回去向，原扣减记录不会被改写。
        {creditDenominationLabel}，不可兑换、不可提现。不同模型与用量的消耗不同，这里的历史金额不是「还能生成几次」的承诺。
      </p>
    </section>
  </main>;
}
