'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Space, Table, Tag, Typography } from 'antd';
import { api } from '@/client/api';
import { generationStatusLabels, stopReasonLabels } from '@/components/chat/generation-usage';
import {
  chargeStatusLabels, reconcileOutcomeLabels,
  type PendingSettlementItem, type PendingSettlementList, type ReconcileItem, type ReconcileRun, type ReconcileOutcome,
} from '@/shared/billing';
import styles from '@/components/admin-view.module.css';

/**
 * 补结算的 Admin 入口（issue #93）：列出终态缺账与待补价的账单，按条或整批重试。
 * 重试走与实时结算同一个幂等入口（`POST admin/billing/reconcile`），重复点不会重复扣费。
 */

const outcomeColors: Record<ReconcileOutcome, string> = {
  settled: 'green',
  retried: 'blue',
  skipped: 'orange',
  failed: 'red',
};

export function ReconcilePanel() {
  const { message } = App.useApp();
  const [items, setItems] = useState<PendingSettlementItem[]>([]);
  const [results, setResults] = useState<ReconcileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api<PendingSettlementList>('admin/billing/reconcile');
      setItems(list.items);
      setError(null);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function retry(generationId?: string) {
    setBusy(generationId ?? 'all');
    try {
      const run = await api<ReconcileRun>('admin/billing/reconcile', {
        limit: 50,
        ...(generationId === undefined ? {} : { generationId }),
      });
      setResults(run.results);
      setError(null);
      message.success(`扫描 ${run.scanned} 条：新结算 ${run.settled} 条，仍待处理 ${run.skipped} 条`);
      await reload();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return <section className={styles.adminPage}>
    <div className={styles.sectionHeading}>
      <h2>补结算与核对</h2>
      <span className={styles.statusHint}>终态但没有账单，或缺费率、有晚到用量的账单；重试不会重复扣费</span>
      <Space style={{ marginLeft: 'auto' }}>
        <Button loading={busy === 'all'} onClick={() => void retry()}>扫描并重试（最多 50 条）</Button>
        <Button loading={loading} onClick={() => void reload()}>刷新待处理</Button>
      </Space>
    </div>
    {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
    <Table<PendingSettlementItem>
      rowKey="generationId"
      size="small"
      loading={loading}
      dataSource={items}
      pagination={false}
      scroll={{ x: 900 }}
      locale={{ emptyText: '没有待处理的结算' }}
      columns={[
        { title: 'Generation', dataIndex: 'generationId', render: value => <Typography.Text copyable>{value}</Typography.Text> },
        { title: '用户', dataIndex: 'userId' },
        { title: '应用', dataIndex: 'appId' },
        {
          title: '生成状态',
          dataIndex: 'generationStatus',
          render: (value: PendingSettlementItem['generationStatus'], row) =>
            row.stopReason ? stopReasonLabels[row.stopReason] : (value ? generationStatusLabels[value] ?? value : '—'),
        },
        {
          title: '账单',
          dataIndex: 'chargeStatus',
          render: (value: PendingSettlementItem['chargeStatus'], row) =>
            value === null ? '缺账' : `${chargeStatusLabels[value]}（${row.credits ?? 0} Credit）`,
        },
        {
          title: '待处理原因',
          dataIndex: 'reason',
          render: (value: string, row) => row.missingSteps > 0 ? `${value}（缺 ${row.missingSteps} 步）` : value,
        },
        {
          title: '操作',
          key: 'retry',
          render: (_: unknown, row) => <Button
            size="small"
            loading={busy === row.generationId}
            onClick={() => void retry(row.generationId)}
          >重试</Button>,
        },
      ]}
    />
    {results.length > 0 && <>
      <div className={styles.sectionHeading}>
        <h2>最近一次重试结果</h2>
        <span className={styles.statusHint}>已结算 = 新建账单并扣款；已补记 = 给已有账单补差额；仍待处理 = 还缺费率或样本；失败 = 需要看原因</span>
      </div>
      <Table<ReconcileItem>
        rowKey="generationId"
        size="small"
        dataSource={results}
        pagination={false}
        columns={[
          { title: 'Generation', dataIndex: 'generationId' },
          {
            title: '结果',
            dataIndex: 'outcome',
            render: (value: ReconcileOutcome) => <Tag color={outcomeColors[value]}>{reconcileOutcomeLabels[value]}</Tag>,
          },
          { title: '说明', dataIndex: 'reason', render: (value?: string) => value ?? '—' },
        ]}
      />
    </>}
  </section>;
}
