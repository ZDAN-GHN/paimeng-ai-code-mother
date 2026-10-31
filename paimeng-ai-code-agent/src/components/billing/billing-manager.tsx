'use client';
import { useState } from 'react';
import { App, Button, Descriptions, Form, Input, InputNumber, Select, Tag } from 'antd';
import { api } from '@/client/api';
import { AdminGuard, useAuth } from '@/components/providers';
import { formatStoredTime } from '@/shared/display';
import {
  grantSources, maxGrantCredits, poolLabels, poolOfSource, sourceLabels,
  type CreditGrantView, type GrantReceipt, type GrantSource,
} from '@/shared/billing';
import { CreditBalance } from './credit-balance';
import styles from '@/components/admin-view.module.css';

type GrantForm = { userId: string; source: GrantSource; credits: number; note?: string };
type Receipt = { view: CreditGrantView; created: boolean };

/** 月度配额由系统按账期发放，管理界面只能选购买与补偿。 */
const grantOptions = grantSources
  .filter(source => source !== 'monthly_quota')
  .map(source => ({ value: source, label: sourceLabels[source] }));

/** 提交时间的 UTC 朴素时间戳，与 `now()` 同格式，交给 formatStoredTime 按本地时区显示。 */
function stamp(): string {
  return new Date().toISOString().slice(0, 23).replace('T', ' ');
}

export function BillingManager() {
  return <AdminGuard><GrantPanel /></AdminGuard>;
}

function GrantPanel() {
  const { user } = useAuth();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  // 幂等键跟着「一次发放意图」走：表单重试与双击复用同一个 requestId，成功入账后才换新的。
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  async function submit(values: GrantForm) {
    setBusy(true);
    try {
      const result = await api<GrantReceipt>('admin/billing/grant', { ...values, requestId });
      setReceipt({
        created: result.created,
        view: {
          id: result.grantId,
          userId: values.userId,
          pool: poolOfSource(values.source),
          credits: result.credits,
          source: values.source,
          note: values.note?.trim() ? values.note.trim() : null,
          requestId,
          grantedBy: user?.id ?? null,
          period: null,
          createTime: stamp(),
        },
      });
      setRequestId(crypto.randomUUID());
      message.success(result.created ? '发放成功' : '这次请求之前已经入账，没有重复发放');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <main className={styles.adminPage}>
    <div className={styles.toolbar}>
      <h1>计费管理</h1>
      <div style={{ marginLeft: 'auto' }}>
        <CreditBalance refreshToken={receipt?.view.id} />
      </div>
    </div>
    <div className={styles.sectionHeading}>
      <h2>发放 Credit</h2>
      <span className={styles.statusHint}>购买计入透支基数，管理员补偿不计入；两者都进入余额池</span>
    </div>
    <Form name="billing-grant" layout="inline" onFinish={submit}>
      <Form.Item label="用户 ID" name="userId" rules={[{ required: true, message: '请输入用户 ID' }]}>
        <Input aria-label="用户 ID" placeholder="输入用户 ID" allowClear />
      </Form.Item>
      <Form.Item label="来源" name="source" initialValue="purchase" rules={[{ required: true, message: '请选择来源' }]}>
        <Select aria-label="来源" style={{ width: 160 }} options={grantOptions} />
      </Form.Item>
      <Form.Item label="金额（Credit）" name="credits" rules={[{ required: true, message: '请输入发放金额' }]}>
        <InputNumber aria-label="发放金额" min={1} max={maxGrantCredits} style={{ width: 160 }} />
      </Form.Item>
      <Form.Item label="备注" name="note">
        <Input aria-label="备注" placeholder="可空，会记入发放记录" maxLength={500} style={{ width: 240 }} />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={busy}>发放</Button>
      </Form.Item>
    </Form>
    {receipt && <>
      <div className={styles.sectionHeading}>
        <h2>最近一次发放</h2>
        <Tag color={receipt.created ? 'green' : 'default'}>{receipt.created ? '已入账' : '重放，未重复入账'}</Tag>
      </div>
      <Descriptions bordered size="small" column={2} items={[
        { key: 'id', label: 'Grant ID', children: receipt.view.id },
        { key: 'createTime', label: '提交时间', children: formatStoredTime(receipt.view.createTime) },
        { key: 'userId', label: '用户 ID', children: receipt.view.userId },
        { key: 'grantedBy', label: '操作人', children: receipt.view.grantedBy ?? '系统' },
        { key: 'source', label: '来源', children: sourceLabels[receipt.view.source] },
        { key: 'pool', label: '入账池', children: poolLabels[receipt.view.pool] },
        { key: 'credits', label: '金额', children: `${receipt.view.credits} Credit` },
        { key: 'note', label: '备注', children: receipt.view.note ?? '无' },
      ]} />
    </>}
  </main>;
}
