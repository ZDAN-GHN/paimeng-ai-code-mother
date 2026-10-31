'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Form, Input, InputNumber, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { z } from 'zod';
import { api, ApiResponseError } from '@/client/api';
import { defaultModelProviderId } from '@/shared/model-config';
import {
  costBases,
  costBasisLabels,
  rateCardListSchema,
  rateCardViewSchema,
  type CostBasis,
  type RateCardList,
  type RateCardView,
} from '@/shared/billing';
import styles from '../admin-view.module.css';

/**
 * Rate card 维护：展示全部费率版本，并为某个提供商 + 模型的组合追加一个带生效时间的新版本。
 * 表只追加，所以这里没有编辑与删除 —— 改价就是再写一个更晚生效的版本。
 */

type FormValues = {
  providerId: string;
  modelName: string;
  effectiveFrom: string;
  creditInputMiss: number;
  creditInputHit: number;
  creditOutput: number;
  usdInputMiss?: string;
  usdInputHit?: string;
  usdOutput?: string;
  costBasis?: CostBasis;
  costSource?: string;
  note?: string;
};

type Outcome<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/** 写操作要区分 409（同版本已存在）与其它失败，所以自己保留 HTTP 状态。 */
async function adminCall<T>(path: string, payload: unknown, parse: (data: unknown) => T): Promise<Outcome<T>> {
  try {
    return { ok: true, data: parse(await api<unknown>(path, payload)) };
  } catch (error) {
    if (error instanceof ApiResponseError) return { ok: false, status: error.status, message: error.message };
    if (error instanceof z.ZodError) return { ok: false, status: 0, message: '响应格式不正确' };
    return { ok: false, status: 0, message: (error as Error).message || '网络请求失败，请稍后重试' };
  }
}

/** 与库里的 now() 同一格式：UTC 朴素时间戳，毫秒 3 位。 */
function utcNow(): string {
  return new Date().toISOString().slice(0, 23).replace('T', ' ');
}

function versionKey(rate: { providerId: string; modelName: string; effectiveFrom: string }): string {
  return [rate.providerId, rate.modelName, rate.effectiveFrom].join('\u0000');
}

/** 空白的可选字段送 null，而不是空字符串：服务端把 null 读成「未知」。 */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function RateCardPanel() {
  const { message } = App.useApp();
  const [list, setList] = useState<RateCardList | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [form] = Form.useForm<FormValues>();

  const reload = useCallback(async () => {
    setLoading(true);
    const outcome = await adminCall('admin/billing/rate-card', undefined, (data) => rateCardListSchema.parse(data));
    if (outcome.ok) {
      setList(outcome.data);
      setError(null);
    } else {
      setError(outcome.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function append(values: FormValues) {
    setSaving(true);
    try {
      const outcome = await adminCall(
        'admin/billing/rate-card',
        {
          ...values,
          usdInputMiss: blankToNull(values.usdInputMiss),
          usdInputHit: blankToNull(values.usdInputHit),
          usdOutput: blankToNull(values.usdOutput),
          costBasis: values.costBasis ?? null,
          costSource: blankToNull(values.costSource),
          note: blankToNull(values.note),
        },
        (data) => rateCardViewSchema.parse(data),
      );
      if (!outcome.ok) {
        // 400（费率非法）与 409（同生效时间已有版本）都是可修正的输入问题，留在表单上方展示。
        if (outcome.status === 400 || outcome.status === 409) setRejected(outcome.message);
        else message.error(outcome.message);
        return;
      }
      setRejected(null);
      message.success(`已追加 ${outcome.data.providerId} / ${outcome.data.modelName} 在 ${outcome.data.effectiveFrom} 生效的费率`);
      await reload();
    } finally {
      setSaving(false);
    }
  }

  const nowKeys = new Set((list?.effectiveNow ?? []).map(versionKey));

  const columns: ColumnsType<RateCardView> = [
    {
      title: '提供商',
      dataIndex: 'providerId',
      width: 150,
      render: (value: string) => <code>{value}</code>,
    },
    {
      title: '模型',
      dataIndex: 'modelName',
      width: 190,
      render: (value: string) => <code>{value}</code>,
    },
    {
      title: '生效时间（UTC）',
      dataIndex: 'effectiveFrom',
      width: 210,
      render: (value: string, row) => (
        <Space size={4} wrap>
          <span>{value}</span>
          {nowKeys.has(versionKey(row)) ? <Tag color="orange">现行</Tag> : null}
        </Space>
      ),
    },
    ...(list?.columns ?? []).map((column) => ({
      title: column.label,
      dataIndex: column.key,
      width: 140,
      align: 'right' as const,
      render: (value: number) => value.toLocaleString('en-US'),
    })),
    {
      title: '上游成本（USD / 1M tokens）',
      key: 'cost',
      width: 260,
      render: (_, row) => <CostCell rate={row} />,
    },
    {
      title: '成本来源',
      dataIndex: 'costSource',
      width: 240,
      render: (value: string | null) =>
        value ? <span className={styles.slotName}>{value}</span> : <span className={styles.textGray}>未记录</span>,
    },
    {
      title: '备注',
      dataIndex: 'note',
      render: (value: string | null) => value ?? <span className={styles.textGray}>—</span>,
    },
    {
      title: '记录人',
      dataIndex: 'createdBy',
      width: 120,
      render: (value: string | null) =>
        value ? <span className={styles.slotName}>{value}</span> : <span className={styles.textGray}>初始费率</span>,
    },
  ];

  return (
    <>
      <div className={styles.sectionHeading}>
        <h2>Rate card</h2>
        <span className={styles.statusHint}>
          按提供商与实际模型维护费率；改价只追加带生效时间的新版本，历史版本不被覆盖
        </span>
      </div>

      {error ? (
        <Alert type="error" showIcon title="费率表读取失败" description={error} style={{ marginBottom: 16 }} />
      ) : null}

      <Table<RateCardView>
        rowKey={versionKey}
        size="small"
        loading={loading}
        dataSource={list?.rates ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={columns}
      />

      <div className={styles.rateCardLegend}>
        <span>{list?.unit.rateLabel ?? 'Credit / 1M tokens'}：单位是每百万 token 的 Credit</span>
        <span>{list?.unit.denominationLabel ?? '1 Credit = ¥0.01'}（面额不可变，改价只改本表）</span>
      </div>

      <Form<FormValues>
        form={form}
        layout="vertical"
        className={styles.rateCardForm}
        initialValues={{ providerId: defaultModelProviderId, effectiveFrom: utcNow() }}
        onFinish={(values) => void append(values)}
      >
        <Form.Item label="提供商 ID" name="providerId" rules={[{ required: true, message: '请填写提供商 ID' }]}>
          <Input aria-label="提供商 ID" placeholder={defaultModelProviderId} autoComplete="off" />
        </Form.Item>
        <Form.Item label="模型名" name="modelName" rules={[{ required: true, message: '请填写模型名' }]}>
          <Input aria-label="模型名" placeholder="deepseek-flash" autoComplete="off" />
        </Form.Item>
        <Form.Item label="生效时间（UTC）" name="effectiveFrom" rules={[{ required: true, message: '请填写生效时间' }]}>
          <Input aria-label="生效时间" placeholder="2026-11-01 00:00:00.000" autoComplete="off" />
        </Form.Item>
        <Form.Item label="缓存未命中输入费率" name="creditInputMiss" rules={[{ required: true, message: '请填写费率' }]}>
          <InputNumber aria-label="缓存未命中输入费率" min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="缓存命中输入费率" name="creditInputHit" rules={[{ required: true, message: '请填写费率' }]}>
          <InputNumber aria-label="缓存命中输入费率" min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="输出费率" name="creditOutput" rules={[{ required: true, message: '请填写费率' }]}>
          <InputNumber aria-label="输出费率" min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="上游成本口径" name="costBasis">
          <Select
            aria-label="上游成本口径"
            allowClear
            placeholder="成本未知"
            options={costBases.map((basis) => ({ value: basis, label: costBasisLabels[basis] }))}
          />
        </Form.Item>
        <Form.Item label="上游未命中输入成本" name="usdInputMiss">
          <Input aria-label="上游未命中输入成本" placeholder="0.300000" autoComplete="off" />
        </Form.Item>
        <Form.Item label="上游命中输入成本" name="usdInputHit">
          <Input aria-label="上游命中输入成本" placeholder="0.006000" autoComplete="off" />
        </Form.Item>
        <Form.Item label="上游输出成本" name="usdOutput">
          <Input aria-label="上游输出成本" placeholder="1.200000" autoComplete="off" />
        </Form.Item>
        <Form.Item label="成本来源" name="costSource">
          <Input aria-label="成本来源" placeholder="https://api-docs.deepseek.com/quick_start/pricing" autoComplete="off" />
        </Form.Item>
        <Form.Item label="备注" name="note">
          <Input aria-label="备注" placeholder="按上游峰时价 × 3 定价" autoComplete="off" />
        </Form.Item>
        <div className={styles.rateCardActions}>
          <Button type="primary" htmlType="submit" loading={saving}>
            追加版本
          </Button>
          <span className={styles.statusHint}>上游成本未知就留空，不要拿售价折算</span>
        </div>
      </Form>

      {rejected ? (
        <Alert type="error" showIcon title="版本未追加" description={rejected} style={{ marginTop: 16 }} />
      ) : null}
    </>
  );
}

function CostCell({ rate }: { rate: RateCardView }) {
  if (rate.costBasis === null || rate.costBasis === 'unknown') {
    return (
      <Space size={4} wrap>
        <Tag>{costBasisLabels.unknown}</Tag>
        <span className={styles.textGray}>不计毛利</span>
      </Space>
    );
  }
  return (
    <div className={styles.rateCardCost}>
      <Tag color="blue">{costBasisLabels[rate.costBasis]}</Tag>
      <span className={styles.slotName}>
        未命中 {rate.usdInputMiss ?? '—'} / 命中 {rate.usdInputHit ?? '—'} / 输出 {rate.usdOutput ?? '—'}
      </span>
    </div>
  );
}
