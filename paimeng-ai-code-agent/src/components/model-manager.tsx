'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiResponseError, readApiResponse } from '@/client/api';
import { AdminGuard } from './providers';
import styles from './admin-view.module.css';
import {
  baseModelApiKeyEnv,
  modelAdminConfigViewSchema,
  modelConfigVersionSchema,
  modelProviderChoiceOptionKeys,
  modelProviderOptionChoices,
  modelProviderOptionLabels,
  modelProviderOptionKeys,
  aliasPurposeOf,
  providerHeaderLimit,
  providerHeaderNameSchema,
  providerHeaderValueSchema,
  optionalModelAliases,
  providerOptionKeysByFormat,
  providerOptionsSchema,
  providerModelListLimit,
  providerModelsViewSchema,
  reasoningLevelLabels,
  reasoningLevels,
  type ModelProviderOptionKey,
  providerApiFormats,
  type ModelAdminConfigView,
  type ModelAlias,
  type ModelAliasCapabilities,
  type ModelAliasInput,
  type ModelAliasSettings,
  type ModelConfigVersion,
  type OptionalModelAlias,
  type ModelProviderOptions,
  type ModelProviderView,
  type ModelProviderWriteInput,
  type ProviderModelsView,
  type ProviderApiFormat,
  type ProviderKeySource,
  type ReasoningLevel,
} from '@/shared/model-config';

/** 上游列表在服务端按 providerModelListLimit 截断，命中上限时明确告知，避免管理员以为模型丢了。 */
function modelListLimitHint(count: number): string {
  return count >= providerModelListLimit ? `（已达到 ${providerModelListLimit} 条上限，其余未显示）` : '';
}

type AdminOutcome<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

type ProviderHeaderRow = { name: string; value: string };

type ProviderFormValues = {
  id: string;
  displayName: string;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  apiKeySource: ProviderKeySource;
  apiKeyEnv: string;
  apiKey: string;
  options: ModelProviderOptions;
  requestHeaders: ProviderHeaderRow[];
  enabled: boolean;
};

type AliasFormValues = {
  alias: string;
  providerId: string;
  modelName: string;
  capabilities: ModelAliasCapabilities;
  settings: {
    temperature?: number | null;
    topP?: number | null;
    maxOutputTokens?: number | null;
    reasoning?: ReasoningLevel | null;
    reasoningContentPassthrough?: boolean;
  };
  enabled: boolean;
};

type ProviderEditor = { mode: 'create' } | { mode: 'edit'; original: ModelProviderView };
type AliasEditor = { mode: 'create'; prefill?: OptionalModelAlias } | { mode: 'edit'; original: ModelAlias };

export function ModelManager() {
  return (
    <AdminGuard>
      <ModelConfigManager />
    </AdminGuard>
  );
}

function ModelConfigManager() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<ModelAdminConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [providerEditor, setProviderEditor] = useState<ProviderEditor | null>(null);
  const [aliasEditor, setAliasEditor] = useState<AliasEditor | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeText, setProbeText] = useState<string | null>(null);
  const [upstreamModels, setUpstreamModels] = useState<ProviderModelsView['models']>([]);
  const [providerForm] = Form.useForm<ProviderFormValues>();
  const [aliasForm] = Form.useForm<AliasFormValues>();

  const reload = useCallback(async () => {
    setLoading(true);
    const outcome = await adminPost('model/admin/config', {}, (data) => modelAdminConfigViewSchema.parse(data));
    if (outcome.ok) {
      setConfig(outcome.data);
      setError(null);
      setConflict(null);
    } else {
      setError(outcome.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function runOperation(
    operation: () => Promise<AdminOutcome<ModelConfigVersion>>,
    onSuccess: () => void,
    successText: string,
  ) {
    setSaving(true);
    try {
      const outcome = await operation();
      if (outcome.ok) {
        setConflict(null);
        onSuccess();
        message.success(successText);
        await reload();
        return;
      }
      if (outcome.status === 409) {
        setConflict(outcome.message);
        return;
      }
      message.error(outcome.message);
    } finally {
      setSaving(false);
    }
  }

  function openCreateProvider() {
    setConflict(null);
    setProviderEditor({ mode: 'create' });
  }

  function openEditProvider(row: ModelProviderView) {
    setConflict(null);
    setProviderEditor({ mode: 'edit', original: row });
  }

  function openCreateAlias(prefill?: OptionalModelAlias) {
    setConflict(null);
    setAliasEditor({ mode: 'create', ...(prefill ? { prefill } : {}) });
  }

  function openEditAlias(row: ModelAlias) {
    setConflict(null);
    setAliasEditor({ mode: 'edit', original: row });
  }

  function closeProviderEditor() {
    setProviderEditor(null);
    setConflict(null);
  }

  function closeAliasEditor() {
    setAliasEditor(null);
    setConflict(null);
  }

  useEffect(() => {
    if (!providerEditor) return;
    setProbeText(null);
    providerForm.setFieldsValue(
      providerEditor.mode === 'edit' ? providerFormValues(providerEditor.original) : emptyProviderValues(),
    );
  }, [providerEditor, providerForm]);

  /** 用当前表单值测试上游连通性；直接输入的密钥留空时，服务端沿用库里已保存的密文。 */
  async function testProviderConnection() {
    try {
      const values = await providerForm.validateFields();
      setProbing(true);
      setProbeText(null);
      const outcome = await adminPost(
        'model/admin/provider/models',
        { provider: toProviderInput(values) },
        (data) => providerModelsViewSchema.parse(data),
      );
      if (outcome.ok) {
        setUpstreamModels(outcome.data.models);
        const ids = outcome.data.models.slice(0, 20).map((model) => model.id).join('、');
        const suffix = outcome.data.models.length > 20 ? ' 等' : '';
        setProbeText(`连接正常，共 ${outcome.data.models.length} 个模型${modelListLimitHint(outcome.data.models.length)}：${ids}${suffix}`);
      } else {
        setProbeText(outcome.message);
      }
    } catch {
    } finally {
      setProbing(false);
    }
  }

  /** 拉取所选提供商的上游模型名，供别名的「上游模型名」下拉选择。 */
  async function loadAliasModels() {
    if (!config) return;
    const selected: unknown = aliasForm.getFieldValue('providerId');
    const provider = config.providers.find((candidate) => candidate.id === selected);
    if (!provider) {
      message.warning('请先选择提供商');
      return;
    }
    setProbing(true);
    setProbeText(null);
    const outcome = await adminPost(
      'model/admin/provider/models',
      { provider: providerWriteFromView(provider) },
      (data) => providerModelsViewSchema.parse(data),
    );
    setProbing(false);
    if (outcome.ok) {
      setUpstreamModels(outcome.data.models);
      message.success(`已获取 ${outcome.data.models.length} 个上游模型${modelListLimitHint(outcome.data.models.length)}`);
      return;
    }
    setProbeText(outcome.message);
    message.error(outcome.message);
  }

  useEffect(() => {
    if (!aliasEditor) return;
    setProbeText(null);
    setUpstreamModels([]);
    aliasForm.setFieldsValue(
      aliasEditor.mode === 'edit' ? aliasFormValues(aliasEditor.original) : emptyAliasValues(aliasEditor.prefill),
    );
  }, [aliasEditor, aliasForm]);

  async function submitProvider(applyImmediately: boolean) {
    try {
      const values = await providerForm.validateFields();
      await saveProvider(values, applyImmediately);
    } catch {
    }
  }

  async function submitAlias(applyImmediately: boolean) {
    try {
      const values = await aliasForm.validateFields();
      await saveAlias(values, applyImmediately);
    } catch {
    }
  }

  async function saveProvider(values: ProviderFormValues, applyImmediately: boolean) {
    if (!config || !providerEditor) return;
    const provider = toProviderInput(values);
    await runOperation(
      () =>
        adminPost(
          'model/admin/provider/upsert',
          { provider, expectedRevision: config.revision, applyImmediately },
          (data) => modelConfigVersionSchema.parse(data),
        ),
      () => setProviderEditor(null),
      applyImmediately ? '提供商已保存并立即生效' : '提供商已保存',
    );
  }

  async function saveAlias(values: AliasFormValues, applyImmediately: boolean) {
    if (!config || !aliasEditor) return;
    const alias = toAliasInput(values);
    await runOperation(
      () =>
        adminPost(
          'model/admin/alias/upsert',
          { alias, expectedRevision: config.revision, applyImmediately },
          (data) => modelConfigVersionSchema.parse(data),
        ),
      () => setAliasEditor(null),
      applyImmediately ? '别名已保存并立即生效' : '别名已保存',
    );
  }

  async function removeProvider(row: ModelProviderView) {
    if (!config) return;
    await runOperation(
      () =>
        adminPost(
          'model/admin/provider/delete',
          { id: row.id, expectedRevision: config.revision },
          (data) => modelConfigVersionSchema.parse(data),
        ),
      () => undefined,
      '提供商已删除',
    );
  }

  async function removeAlias(row: ModelAlias) {
    if (!config) return;
    await runOperation(
      () =>
        adminPost(
          'model/admin/alias/delete',
          { alias: row.alias, expectedRevision: config.revision },
          (data) => modelConfigVersionSchema.parse(data),
        ),
      () => undefined,
      '别名已删除',
    );
  }

  async function applyNow() {
    if (!config) return;
    await runOperation(
      () =>
        adminPost(
          'model/admin/apply',
          { expectedRevision: config.revision },
          (data) => modelConfigVersionSchema.parse(data),
        ),
      () => undefined,
      '已请求所有实例立即重新加载模型配置',
    );
  }

  if (loading && !config) {
    return (
      <main className={styles.adminPage}>
        <p>正在加载模型配置…</p>
      </main>
    );
  }

  if (!config) {
    return (
      <main className={styles.adminPage}>
        <Alert
          type="error"
          showIcon
          title="模型配置加载失败"
          description={error ?? '未知错误'}
          action={
            <Button size="small" onClick={() => void reload()}>
              重试
            </Button>
          }
        />
      </main>
    );
  }

  const requiredAliasSet = new Set<string>(config.requiredAliases);
  /** 尚未配置的可选别名：给出预填入口，而不是让用户自己猜别名名字。 */
  const missingOptionalAliases = (Object.keys(optionalModelAliases) as OptionalModelAlias[])
    .filter(name => !config.aliases.some(alias => alias.alias === name));

  const providerColumns: ColumnsType<ModelProviderView> = [
    { title: 'ID', dataIndex: 'id' },
    { title: '名称', dataIndex: 'displayName' },
    {
      title: 'API 格式',
      dataIndex: 'apiFormat',
      render: (_, row) => formatLabel(config, row.apiFormat),
    },
    { title: '地址', dataIndex: 'baseUrl', render: (value: string) => <span className={styles.promptText}>{value}</span> },
    {
      title: '密钥来源',
      dataIndex: 'apiKeySource',
      render: (_, row) =>
        row.apiKeySource === 'env' ? `环境变量 ${row.apiKeyEnv}` : <span className={styles.textGray}>直接输入</span>,
    },
    {
      title: '密钥状态',
      dataIndex: 'apiKeyConfigured',
      render: (_, row) => (row.apiKeyConfigured ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      render: (value: boolean) => (value ? <Tag color="blue">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: '选项',
      dataIndex: 'options',
      render: (_, row) => {
        const enabledOptions = formatOptionKeys(config, row.apiFormat).filter((key) => row.options[key] === true);
        if (enabledOptions.length === 0) return <span className={styles.textGray}>默认</span>;
        return enabledOptions.map((key) => <Tag key={key}>{modelProviderOptionLabels[key]}</Tag>);
      },
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => openEditProvider(row)}>
            编辑
          </Button>
          <Popconfirm title="删除该提供商？" onConfirm={() => void removeProvider(row)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const aliasColumns: ColumnsType<ModelAlias> = [
    {
      title: '别名',
      dataIndex: 'alias',
      render: (_, row) => {
        const purpose = aliasPurposeOf(row.alias);
        return (
          <Space>
            <span>{row.alias}</span>
            {requiredAliasSet.has(row.alias) ? <Tag color="orange">必需</Tag> : null}
            {purpose ? <Tag color="geekblue">{purpose.label}</Tag> : null}
          </Space>
        );
      },
    },
    { title: '提供商', dataIndex: 'providerId' },
    { title: '上游模型名', dataIndex: 'modelName' },
    { title: '能力', dataIndex: 'capabilities', render: (_, row) => capabilityTags(row.capabilities) },
    { title: '参数', dataIndex: 'settings', render: (_, row) => formatSettings(row.settings) },
    {
      title: '启用',
      dataIndex: 'enabled',
      render: (value: boolean) => (value ? <Tag color="blue">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => openEditAlias(row)}>
            编辑
          </Button>
          {requiredAliasSet.has(row.alias) ? (
            <Button size="small" danger disabled>
              删除
            </Button>
          ) : (
            <Popconfirm title="删除该别名？" onConfirm={() => void removeAlias(row)}>
              <Button size="small" danger>
                删除
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <main className={styles.adminPage}>
      <div className={styles.toolbar}>
        <h1>模型管理</h1>
        <Space>
          <Button onClick={() => void reload()} loading={loading}>
            刷新
          </Button>
          {config.initialized ? (
            <Popconfirm title="让所有实例立即重新加载模型配置？" onConfirm={() => void applyNow()}>
              <Button disabled={saving} loading={saving}>
                立即生效
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      </div>

      {error ? (
        <Alert
          type="error"
          showIcon
          title="模型配置刷新失败"
          description={error}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {conflict && !providerEditor && !aliasEditor ? (
        <Alert
          type="error"
          showIcon
          title="操作失败：模型配置已被其他操作修改"
          description={
            <Space orientation="vertical" size={4}>
              <span>{conflict}</span>
              <Space>
                <Button size="small" onClick={() => void reload()}>
                  重新加载
                </Button>
                <Button size="small" onClick={() => setConflict(null)}>
                  忽略
                </Button>
              </Space>
            </Space>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {!config.initialized ? (
        <>
          <Alert
            type="info"
            showIcon
            title="模型配置尚未初始化"
            description={
              <div>
                <p>当前数据库中没有可用的模型提供商与别名。请在服务器上执行一次初始化命令，从环境变量导入默认提供商与必需别名：</p>
                <p>
                  <code>npm run db:init-models</code>
                </p>
                <p>初始化完成后再点击“刷新”。本页面不会自动初始化，也不会写入任何密钥。</p>
              </div>
            }
          />
          <Empty description="暂无模型配置" style={{ marginTop: 24 }} />
        </>
      ) : (
        <>
          <div className={styles.sectionHeading}>
            <h2>当前实例状态</h2>
            <span className={styles.statusHint}>仅反映处理本次请求的实例，其他实例可能尚未刷新</span>
          </div>
          <Descriptions
            bordered
            size="small"
            column={2}
            items={[
              { key: 'revision', label: '数据库配置版本', children: config.revision },
              { key: 'instanceRevision', label: '实例生效版本', children: config.instance.revision ?? '未加载' },
              {
                key: 'source',
                label: '实例配置来源',
                children:
                  config.instance.source === 'database'
                    ? '数据库'
                    : config.instance.source === 'environment'
                      ? '环境变量'
                      : '未知',
              },
              { key: 'epoch', label: '实例刷新批次', children: config.instance.refreshEpoch ?? '未加载' },
              {
                key: 'degraded',
                label: '实例状态',
                children: config.instance.degraded ? <Tag color="red">降级</Tag> : <Tag color="green">正常</Tag>,
              },
              { key: 'readAt', label: '最近读取时间', children: formatClock(config.instance.readAt) },
              { key: 'loadedAt', label: '最近加载时间', children: formatClock(config.instance.loadedAt) },
              { key: 'lastError', label: '最近错误', children: config.instance.lastError ?? '无' },
            ]}
          />

          <div className={styles.sectionHeading}>
            <h2>提供商</h2>
            <Button type="primary" onClick={openCreateProvider} disabled={saving}>
              新增提供商
            </Button>
          </div>
          <Table<ModelProviderView>
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={config.providers}
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={providerColumns}
          />

          <div className={styles.sectionHeading}>
            <h2>别名</h2>
            <Space>
              {missingOptionalAliases.map((name) => (
                <Button key={name} onClick={() => openCreateAlias(name)} disabled={saving}>
                  新增{optionalModelAliases[name].label}别名
                </Button>
              ))}
              <Button type="primary" onClick={() => openCreateAlias()} disabled={saving}>
                新增别名
              </Button>
            </Space>
          </div>
          <Table<ModelAlias>
            rowKey="alias"
            size="small"
            loading={loading}
            dataSource={config.aliases}
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={aliasColumns}
          />
        </>
      )}

      {providerEditor ? (
        <Modal
          open
          title={(providerEditor.mode === 'create' ? '新增提供商' : '编辑提供商')}
          destroyOnHidden
          onCancel={() => {
            if (!saving) setProviderEditor(null);
          }}
          footer={
            <Space>
              <Button onClick={() => setProviderEditor(null)} disabled={saving}>
                取消
              </Button>
              <Button onClick={() => void submitProvider(true)} loading={saving}>
                保存并立即生效
              </Button>
              <Button type="primary" onClick={() => void submitProvider(false)} loading={saving}>
                保存
              </Button>
            </Space>
          }
        >
          {conflict ? <ConflictAlert message={conflict} onReload={() => void reload()} /> : null}
          <Form
            form={providerForm}
            layout="vertical"
            preserve={false}
            initialValues={providerEditor.mode === 'edit' ? providerFormValues(providerEditor.original) : emptyProviderValues()}
          >
            <Form.Item
              name="id"
              label="提供商 ID"
              tooltip="稳定的唯一标识，创建后不可修改"
              rules={[
                { required: true, message: '请输入提供商 ID' },
                { max: 64, message: '最多 64 个字符' },
                {
                  pattern: /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
                  message: '仅小写字母、数字、点、下划线、连字符，且首尾为字母或数字',
                },
              ]}
            >
              <Input disabled={providerEditor.mode === 'edit'} placeholder="例如 env-default" aria-label="提供商 ID" />
            </Form.Item>
            <Form.Item
              name="displayName"
              label="名称"
              rules={[{ required: true, message: '请输入名称' }, { max: 128, message: '最多 128 个字符' }]}
            >
              <Input aria-label="名称" />
            </Form.Item>
            <Form.Item name="apiFormat" label="API 格式" rules={[{ required: true, message: '请选择 API 格式' }]}>
              <Select
                aria-label="API 格式"
                options={config.providerFormats.map((format) => ({ value: format.value, label: format.label }))}
                onChange={(value: ProviderApiFormat) => {
                  providerForm.setFieldValue('options', pickProviderOptions(value, providerForm.getFieldValue('options')));
                }}
              />
            </Form.Item>
            <Form.Item
              name="baseUrl"
              label="地址"
              tooltip="模型服务的 base URL，必须为完整地址"
              rules={[{ required: true, message: '请输入地址' }, { max: 2048, message: '最多 2048 个字符' }]}
            >
              <Input aria-label="地址" placeholder="https://api.example.com/v1" />
            </Form.Item>
            <Form.Item name="apiKeySource" label="密钥来源" rules={[{ required: true, message: '请选择密钥来源' }]}>
              <Select
                aria-label="密钥来源"
                options={[
                  { value: 'env', label: '引用环境变量' },
                  { value: 'inline', label: '直接输入密钥' },
                ]}
              />
            </Form.Item>
            <Form.Item
              noStyle
              shouldUpdate={(previous, current) => previous.apiKeySource !== current.apiKeySource}
            >
              {({ getFieldValue }) =>
                getFieldValue('apiKeySource') === 'env' ? (
                  <Form.Item
                    name="apiKeyEnv"
                    label="密钥环境变量"
                    tooltip="只保存变量名，密钥值仍从进程环境读取"
                    rules={[{ required: true, message: '请选择密钥环境变量' }]}
                  >
                    <Select
                      aria-label="密钥环境变量"
                      options={config.allowedApiKeyEnvs.map((name) => ({ value: name, label: name }))}
                    />
                  </Form.Item>
                ) : (
                  <Form.Item
                    name="apiKey"
                    label="密钥"
                    tooltip="保存后仅以密文入库，页面不会回显；编辑时留空表示保持已保存的密钥"
                    rules={[
                      {
                        required: !(providerEditor.mode === 'edit' && providerEditor.original.apiKeySource === 'inline'),
                        message: '请输入密钥',
                      },
                      { max: 1024, message: '最多 1024 个字符' },
                    ]}
                  >
                    <Input.Password aria-label="密钥" autoComplete="new-password" placeholder="直接粘贴上游密钥" />
                  </Form.Item>
                )
              }
            </Form.Item>
            <Form.Item
              label="连通性"
              tooltip="按当前填写的地址与密钥请求一次上游 /models，只做检测，不会保存任何配置"
            >
        <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                <Button onClick={() => void testProviderConnection()} loading={probing} aria-label="测试连接">
                  测试连接
                </Button>
                {probeText ? <span className={styles.textGray}>{probeText}</span> : null}
              </Space>
            </Form.Item>
            <Form.Item
              noStyle
              shouldUpdate={(previous, current) => previous.apiFormat !== current.apiFormat}
            >
              {({ getFieldValue }) => {
                const optionKeys = formatOptionKeys(config, getFieldValue('apiFormat') as ProviderApiFormat);
                const choiceKeys = optionKeys.filter(isChoiceOptionKey);
                const switchKeys = optionKeys.filter((key) => !isChoiceOptionKey(key));
                return (
                  <Form.Item label="提供商选项" tooltip="不同 API 格式支持的协议选项不同">
                    {optionKeys.length === 0 ? (
                      <span className={styles.textGray}>该 API 格式没有可配置的选项</span>
                    ) : (
                      <Space orientation="vertical" size={8}>
                        {choiceKeys.map((key) => (
                          <Space key={key} size={8}>
                            <span>{modelProviderOptionLabels[key]}</span>
                            <Form.Item name={['options', key]} noStyle>
                              <Select
                                allowClear
                                aria-label={modelProviderOptionLabels[key]}
                                placeholder="不指定"
                                options={[...modelProviderOptionChoices[key]]}
                                style={{ minWidth: 180 }}
                              />
                            </Form.Item>
                          </Space>
                        ))}
                        {switchKeys.length > 0 ? (
                          <Space size={16} wrap>
                            {switchKeys.map((key) => (
                              <Space key={key} size={8}>
                                <span>{modelProviderOptionLabels[key]}</span>
                                <Form.Item name={['options', key]} valuePropName="checked" noStyle>
                                  <Switch aria-label={modelProviderOptionLabels[key]} />
                                </Form.Item>
                              </Space>
                            ))}
                          </Space>
                        ) : null}
                      </Space>
                    )}
                  </Form.Item>
                );
              }}
            </Form.Item>
            <Form.Item
              label="自定义请求头"
              tooltip="随每个上游请求发送的普通 HTTP 头，例如 User-Agent、HTTP-Referer、X-Title；鉴权与传输头由系统生成，不能在这里覆盖"
            >
              <Form.List name="requestHeaders">
                {(fields, { add, remove }) => (
                  <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                    {fields.map((field) => (
                      <Space key={field.key} size={8} align="start">
                        {/* Form 级 preserve={false} 只为丢弃密钥；列表内层若不显式 preserve，值会在子树重挂载时被抹成 undefined */}
                        <Form.Item
                          preserve
                          name={[field.name, 'name']}
                          rules={[
                            { required: true, message: '请输入请求头名称' },
                            {
                              validator: (_rule, value) => {
                                if (value === undefined || value === null || value === '') return Promise.resolve();
                                const parsed = providerHeaderNameSchema.safeParse(value);
                                if (!parsed.success) {
                                  return Promise.reject(new Error(parsed.error.issues[0]?.message ?? '请求头名称不合法'));
                                }
                                const rows: ProviderHeaderRow[] = providerForm.getFieldValue('requestHeaders') ?? [];
                                const target = String(value).trim().toLowerCase();
                                const duplicated = rows.filter((row) => (row?.name ?? '').trim().toLowerCase() === target).length > 1;
                                return duplicated ? Promise.reject(new Error('请求头名称重复')) : Promise.resolve();
                              },
                            },
                          ]}
                        >
                          <Input aria-label="请求头名称" placeholder="User-Agent" />
                        </Form.Item>
                        <Form.Item
                          preserve
                          name={[field.name, 'value']}
                          rules={[
                            { required: true, message: '请输入请求头值' },
                            {
                              validator: (_rule, value) => {
                                if (value === undefined || value === null || value === '') return Promise.resolve();
                                const parsed = providerHeaderValueSchema.safeParse(value);
                                return parsed.success
                                  ? Promise.resolve()
                                  : Promise.reject(new Error(parsed.error.issues[0]?.message ?? '请求头值不合法'));
                              },
                            },
                          ]}
                        >
                          <Input aria-label="请求头值" placeholder="paimeng-ai-code-mother/1.0" />
                        </Form.Item>
                        <Button danger onClick={() => remove(field.name)} aria-label="删除请求头">
                          删除
                        </Button>
                      </Space>
                    ))}
                    <Button
                      onClick={() => add({ name: '', value: '' })}
                      disabled={fields.length >= providerHeaderLimit}
                      aria-label="添加请求头"
                    >
                      添加请求头
                    </Button>
                  </Space>
                )}
              </Form.List>
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch aria-label="启用" />
            </Form.Item>
          </Form>
        </Modal>
      ) : null}

      {aliasEditor ? (
        <Modal
          open
          title={aliasEditor.mode === 'create' ? '新增别名' : '编辑别名'}
          destroyOnHidden
          onCancel={() => {
            if (!saving) setAliasEditor(null);
          }}
          footer={
            <Space>
              <Button onClick={() => setAliasEditor(null)} disabled={saving}>
                取消
              </Button>
              <Button onClick={() => void submitAlias(true)} loading={saving}>
                保存并立即生效
              </Button>
              <Button type="primary" onClick={() => void submitAlias(false)} loading={saving}>
                保存
              </Button>
            </Space>
          }
        >
          {conflict ? <ConflictAlert message={conflict} onReload={() => void reload()} /> : null}
          <Form
            form={aliasForm}
            layout="vertical"
            preserve={false}
            initialValues={aliasEditor.mode === 'edit' ? aliasFormValues(aliasEditor.original) : emptyAliasValues(aliasEditor.prefill)}
          >
            <Form.Item
              name="alias"
              label="别名"
              tooltip="稳定的唯一标识，创建后不可修改"
              rules={[
                { required: true, message: '请输入别名' },
                { max: 64, message: '最多 64 个字符' },
                {
                  pattern: /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
                  message: '仅小写字母、数字、点、下划线、连字符，且首尾为字母或数字',
                },
              ]}
            >
              <Input disabled={aliasEditor.mode === 'edit'} placeholder="例如 codegen.default" aria-label="别名" />
            </Form.Item>
            <Form.Item name="providerId" label="提供商" rules={[{ required: true, message: '请选择提供商' }]}>
              <Select
                aria-label="提供商"
                options={config.providers.map((provider) => ({
                  value: provider.id,
                  label: `${provider.displayName}（${provider.id}）`,
                }))}
              />
            </Form.Item>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 24 }}>
              <Form.Item
                name="modelName"
                label="上游模型名"
                tooltip="可以直接输入，也可以先点“获取模型”从上游 /models 拉取候选"
                rules={[{ required: true, message: '请输入上游模型名' }, { max: 256, message: '最多 256 个字符' }]}
                style={{ flex: 1, minWidth: 0, marginBottom: 0 }}
              >
                <AutoComplete
                  style={{ width: '100%' }}
                  placeholder="例如 deepseek-flash"
                  options={upstreamModels.map((model) => ({ value: model.id, label: model.label }))}
                  filterOption={(input, option) =>
                    `${option?.value ?? ''} ${option?.label ?? ''}`.toLowerCase().includes(input.toLowerCase())
                  }
                />
              </Form.Item>
              <Button onClick={() => void loadAliasModels()} loading={probing}>
                获取模型
              </Button>
            </div>
            {probeText ? <div className={styles.textGray}>{probeText}</div> : null}
            <Form.Item label="能力">
              <Space size={16} wrap>
                <Form.Item name={['capabilities', 'streaming']} valuePropName="checked" noStyle>
                  <Switch aria-label="流式" />
                </Form.Item>
                <span>流式</span>
                <Form.Item name={['capabilities', 'toolCalling']} valuePropName="checked" noStyle>
                  <Switch aria-label="工具调用" />
                </Form.Item>
                <span>工具调用</span>
                <Form.Item name={['capabilities', 'structuredOutput']} valuePropName="checked" noStyle>
                  <Switch aria-label="结构化输出" />
                </Form.Item>
                <span>结构化输出</span>
                <Form.Item name={['capabilities', 'imageInput']} valuePropName="checked" noStyle>
                  <Switch aria-label="图片输入" />
                </Form.Item>
                <span>图片输入</span>
              </Space>
            </Form.Item>
            <Space size={16} wrap>
              <Form.Item
                name={['settings', 'temperature']}
                label="temperature"
                rules={[{ type: 'number', min: 0, max: 2, message: 'temperature 需在 0 到 2 之间' }]}
              >
                <InputNumber min={0} max={2} step={0.1} aria-label="temperature" />
              </Form.Item>
              <Form.Item
                name={['settings', 'topP']}
                label="topP"
                rules={[{ type: 'number', min: 0, max: 1, message: 'topP 需在 0 到 1 之间' }]}
              >
                <InputNumber min={0} max={1} step={0.05} aria-label="topP" />
              </Form.Item>
              <Form.Item
                name={['settings', 'maxOutputTokens']}
                label="最大输出 tokens"
                rules={[{ type: 'integer', min: 1, max: 1000000, message: '最大输出 tokens 需为 1 到 1000000 的整数' }]}
              >
                <InputNumber min={1} max={1000000} step={1} precision={0} aria-label="最大输出 tokens" />
              </Form.Item>
              <Form.Item
                name={['settings', 'reasoning']}
                label="思考强度"
                tooltip="AI SDK 的统一 reasoning 参数：chat 格式映射为 reasoning_effort，responses 格式映射为 reasoning.effort，Anthropic 映射为 thinking 预算"
              >
                <Select
                  allowClear
                  aria-label="思考强度"
                  placeholder="不指定"
                  style={{ minWidth: 140 }}
                  options={reasoningLevels.map((level) => ({ value: level, label: reasoningLevelLabels[level] }))}
                />
              </Form.Item>
              <Form.Item
                name={['settings', 'reasoningContentPassthrough']}
                label="回传思考内容"
                valuePropName="checked"
                tooltip="该别名指向 DeepSeek 类混合推理模型时打开：多轮对话回放历史消息会带上 reasoning_content。经第三方网关访问 DeepSeek 时必须打开，否则上游报 400；只影响这一个别名"
              >
                <Switch aria-label="回传思考内容" />
              </Form.Item>
            </Space>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch aria-label="启用" />
            </Form.Item>
          </Form>
        </Modal>
      ) : null}
    </main>
  );
}

function ConflictAlert({ message, onReload }: { message: string; onReload: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      title="保存失败：模型配置已被其他操作修改"
      description={
        <Space orientation="vertical" size={4}>
          <span>{message}</span>
          <span>当前输入已保留，可先重新加载最新配置再保存。</span>
          <Button size="small" onClick={onReload}>
            重新加载
          </Button>
        </Space>
      }
      style={{ marginBottom: 16 }}
    />
  );
}

async function adminPost<T>(
  path: string,
  payload: unknown,
  parse: (data: unknown) => T,
): Promise<AdminOutcome<T>> {
  try {
    const response = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data = await readApiResponse(response);
    try {
      return { ok: true, data: parse(data) };
    } catch {
      return { ok: false, status: response.status, message: '响应格式不正确' };
    }
  } catch (error) {
    if (error instanceof ApiResponseError) return { ok: false, status: error.status, message: error.message };
    return { ok: false, status: 0, message: '网络请求失败，请稍后重试' };
  }
}

function emptyProviderValues(): ProviderFormValues {
  return {
    id: '',
    displayName: '',
    apiFormat: providerApiFormats[0],
    baseUrl: '',
    apiKeySource: 'env',
    apiKeyEnv: baseModelApiKeyEnv,
    apiKey: '',
    options: {},
    requestHeaders: [],
    enabled: true,
  };
}

function providerFormValues(provider: ModelProviderView): ProviderFormValues {
  return {
    id: provider.id,
    displayName: provider.displayName,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    apiKeySource: provider.apiKeySource,
    apiKeyEnv: provider.apiKeySource === 'env' ? provider.apiKeyEnv : baseModelApiKeyEnv,
    apiKey: '',
    options: { ...provider.options },
    requestHeaders: providerHeaderRows(provider.headers),
    enabled: provider.enabled,
  };
}

/** 格式名称与可选选项都来自服务端下发的名单，界面不硬编码。 */
function formatLabel(config: ModelAdminConfigView, apiFormat: ProviderApiFormat): string {
  return config.providerFormats.find((format) => format.value === apiFormat)?.label ?? apiFormat;
}

function formatOptionKeys(config: ModelAdminConfigView, apiFormat: ProviderApiFormat): ModelProviderOptionKey[] {
  return config.providerFormats.find((format) => format.value === apiFormat)?.optionKeys ?? [];
}

/** 非布尔选项键（下拉型）的判定：渲染与取值共用，避免两处名单漂移。 */
function isChoiceOptionKey(key: ModelProviderOptionKey): key is 'thinkingSwitch' {
  return modelProviderChoiceOptionKeys.includes(key);
}

/** 只保留当前格式支持的选项值，并交给 schema 归一化（布尔开关与下拉取值都在这里过滤）。 */
function pickProviderOptions(apiFormat: ProviderApiFormat, options: ModelProviderOptions | undefined): ModelProviderOptions {
  const allowed = providerOptionKeysByFormat[apiFormat];
  const candidate: Record<string, unknown> = {};
  for (const key of modelProviderOptionKeys) {
    if (!allowed.includes(key)) continue;
    const value = options?.[key];
    if (value === undefined || value === null) continue;
    candidate[key] = value;
  }
  const parsed = providerOptionsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : {};
}

/** 把已保存的请求头拆成表单行，编辑重开时保留原值。 */
function providerHeaderRows(headers: Record<string, string> | undefined): ProviderHeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

/** 把表单行转成请求头 record，并丢掉名称为空的行（新增后未填写的空行不提交）。 */
function providerHeadersFromRows(rows: ProviderHeaderRow[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of rows ?? []) {
    const name = row?.name?.trim() ?? '';
    if (!name) continue;
    headers[name] = row?.value ?? '';
  }
  return headers;
}

function toProviderInput(values: ProviderFormValues): ModelProviderWriteInput {
  const common = {
    id: values.id.trim(),
    displayName: values.displayName.trim(),
    apiFormat: values.apiFormat,
    baseUrl: values.baseUrl.trim(),
    options: pickProviderOptions(values.apiFormat, values.options),
    headers: providerHeadersFromRows(values.requestHeaders),
    enabled: Boolean(values.enabled),
  };
  return values.apiKeySource === 'env'
    ? { ...common, apiKeySource: 'env', apiKeyEnv: values.apiKeyEnv }
    : { ...common, apiKeySource: 'inline', apiKey: values.apiKey ?? '' };
}

/** 由视图构造写入口径：直接输入的密钥留空，服务端会沿用已保存的密文。 */
function providerWriteFromView(provider: ModelProviderView): ModelProviderWriteInput {
  const common = {
    id: provider.id,
    displayName: provider.displayName,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    options: provider.options,
    headers: provider.headers ?? {},
    enabled: provider.enabled,
  };
  return provider.apiKeySource === 'env'
    ? { ...common, apiKeySource: 'env', apiKeyEnv: provider.apiKeyEnv }
    : { ...common, apiKeySource: 'inline', apiKey: '' };
}

function emptyAliasValues(prefill?: OptionalModelAlias): AliasFormValues {
  const optional = prefill ? optionalModelAliases[prefill] : undefined;
  return {
    alias: prefill ?? '',
    providerId: '',
    modelName: '',
    capabilities: optional ? { ...optional.capabilities } : { streaming: true, toolCalling: false, structuredOutput: false, imageInput: false },
    settings: {},
    enabled: true,
  };
}

function aliasFormValues(alias: ModelAlias): AliasFormValues {
  return {
    alias: alias.alias,
    providerId: alias.providerId,
    modelName: alias.modelName,
    capabilities: { ...alias.capabilities },
    settings: {
      temperature: alias.settings.temperature ?? null,
      topP: alias.settings.topP ?? null,
      maxOutputTokens: alias.settings.maxOutputTokens ?? null,
      reasoning: alias.settings.reasoning ?? null,
      reasoningContentPassthrough: alias.settings.reasoningContentPassthrough ?? false,
    },
    enabled: alias.enabled,
  };
}

function toAliasInput(values: AliasFormValues): ModelAliasInput {
  const settings: ModelAliasSettings = {};
  if (typeof values.settings?.temperature === 'number') settings.temperature = values.settings.temperature;
  if (typeof values.settings?.topP === 'number') settings.topP = values.settings.topP;
  if (typeof values.settings?.maxOutputTokens === 'number') settings.maxOutputTokens = values.settings.maxOutputTokens;
  if (values.settings?.reasoning) settings.reasoning = values.settings.reasoning;
  if (values.settings?.reasoningContentPassthrough) settings.reasoningContentPassthrough = true;
  return {
    alias: values.alias.trim(),
    providerId: values.providerId,
    modelName: values.modelName.trim(),
    capabilities: {
      streaming: Boolean(values.capabilities.streaming),
      toolCalling: Boolean(values.capabilities.toolCalling),
      structuredOutput: Boolean(values.capabilities.structuredOutput),
      imageInput: Boolean(values.capabilities.imageInput),
    },
    settings,
    enabled: Boolean(values.enabled),
  };
}

function capabilityTags(capabilities: ModelAliasCapabilities) {
  const labels: [keyof ModelAliasCapabilities, string][] = [
    ['streaming', '流式'],
    ['toolCalling', '工具调用'],
    ['structuredOutput', '结构化输出'],
    ['imageInput', '图片输入'],
  ];
  const active = labels.filter(([key]) => capabilities[key]);
  if (active.length === 0) return <span className={styles.textGray}>无</span>;
  return active.map(([key, label]) => <Tag key={key}>{label}</Tag>);
}

function formatSettings(settings: ModelAliasSettings): string {
  const parts: string[] = [];
  if (settings.temperature != null) parts.push(`temperature ${settings.temperature}`);
  if (settings.topP != null) parts.push(`topP ${settings.topP}`);
  if (settings.maxOutputTokens != null) parts.push(`maxOutputTokens ${settings.maxOutputTokens}`);
  if (settings.reasoning != null) parts.push(`思考 ${reasoningLevelLabels[settings.reasoning]}`);
  if (settings.reasoningContentPassthrough) parts.push('回传思考内容');
  return parts.length > 0 ? parts.join('，') : '默认';
}

function formatClock(value: number | null): string {
  if (value === null) return '—';
  return new Date(value).toLocaleString();
}
