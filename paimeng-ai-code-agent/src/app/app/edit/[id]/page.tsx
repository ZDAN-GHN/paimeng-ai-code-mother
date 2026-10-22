'use client';
import { use, useEffect, useState } from 'react';
import { App as AntApp, Alert, Button, Card, Descriptions, Form, Image, Input, InputNumber, Space } from 'antd';
import { useRouter } from 'next/navigation';
import { api } from '@/client/api';
import { useAuth } from '@/components/providers';
import { UserInfo } from '@/components/user-info';
import { formatCodeGenType, formatStoredTime } from '@/shared/display';
import type { AppInfo } from '@/shared/contracts';
import styles from './edit-view.module.css';

const transparentPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
type EditForm = { appName: string; cover?: string; priority?: number };

export default function AppEdit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading } = useAuth();
  const router = useRouter();
  const { message } = AntApp.useApp();
  const [app, setApp] = useState<AppInfo | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<EditForm>();
  const cover = Form.useWatch('cover', form);
  const isAdmin = user?.userRole === 'admin';
  const canEdit = Boolean(user && (isAdmin || (app && app.userId === user.id)));

  async function fetchApp() {
    try {
      const value = await api<AppInfo>('app/get/vo?id=' + encodeURIComponent(id));
      setError('');
      setApp(value);
      form.setFieldsValue({ appName: value.appName ?? '', cover: value.cover ?? '', priority: value.priority ?? 0 });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => { void fetchApp(); }, [id]);

  async function save(value: EditForm) {
    if (!app) return;
    setSubmitting(true);
    try {
      if (isAdmin) {
        await api('app/admin/update', { id: app.id, appName: value.appName, cover: value.cover || null, priority: value.priority ?? 0 });
      } else {
        await api('app/update', { id: app.id, appName: value.appName });
      }
      message.success('修改成功');
      await fetchApp();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    if (!app) return;
    form.setFieldsValue({ appName: app.appName ?? '', cover: app.cover ?? '', priority: app.priority ?? 0 });
    form.setFields([{ name: 'appName', errors: [] }, { name: 'cover', errors: [] }, { name: 'priority', errors: [] }]);
  }

  const infoItems = app ? [
    { key: 'id', label: '应用ID', children: app.id },
    { key: 'creator', label: '创建者', children: <UserInfo user={app.user} /> },
    { key: 'createTime', label: '创建时间', children: formatStoredTime(app.createTime) },
    { key: 'updateTime', label: '更新时间', children: formatStoredTime(app.updateTime) },
    { key: 'deployedTime', label: '部署时间', children: app.deployedTime ? formatStoredTime(app.deployedTime) : '未部署' },
    {
      key: 'link',
      label: '访问链接',
      children: app.deployKey
        ? <Button type="link" size="small" disabled={!app.previewUrl} onClick={() => { if (app.previewUrl) window.open(app.previewUrl, '_blank', 'noopener'); }}>查看预览</Button>
        : <span>未部署</span>,
    },
  ] : [];

  return <main className={styles.editPage}>
    <div className={styles.pageHeader}><h1>编辑应用信息</h1></div>
    {error ? <Alert type="error" title={error} /> : <div className={styles.editContainer}>
      <Card title="基本信息" loading={!app || loading}>
        {app && !canEdit ? <Alert type="error" title="只有应用创建者可以编辑；管理员请使用应用管理页面" /> :
          <Form form={form} layout="vertical" onFinish={save} initialValues={{ appName: app?.appName ?? '' }}>
            <Form.Item label="应用名称" name="appName" rules={[{ required: true, message: '请输入应用名称' }, { min: 1, max: 50, message: '应用名称长度在1-50个字符' }]}>
              <Input aria-label="应用名称" placeholder="请输入应用名称" maxLength={50} showCount />
            </Form.Item>
            {isAdmin && <Form.Item label="应用封面" name="cover" extra="支持图片链接，建议尺寸：400x300" rules={[{ type: 'url', message: '请输入有效的URL' }]}>
              <Input aria-label="应用封面" placeholder="请输入封面图片链接" />
            </Form.Item>}
            {isAdmin && cover ? <div className={styles.coverPreview}><Image src={cover} width={200} height={150} fallback={transparentPng} alt="应用封面预览" /></div> : null}
            {isAdmin && <Form.Item label="优先级" name="priority" extra="大于等于99为精选应用" rules={[{ type: 'number', min: 0, max: 9999, message: '优先级范围0-9999' }]}>
              <InputNumber aria-label="优先级" min={0} max={9999} style={{ width: 200 }} />
            </Form.Item>}
            <Form.Item label="初始提示词">
              <Input.TextArea value={app?.initPrompt} readOnly rows={4} maxLength={1000} showCount aria-label="初始提示词" />
              <div className={styles.formTip}>初始提示词不可修改</div>
            </Form.Item>
            <Form.Item label="生成类型">
              <Input value={formatCodeGenType(app?.codeGenType)} readOnly aria-label="生成类型" />
              <div className={styles.formTip}>生成类型不可修改</div>
            </Form.Item>
            {app?.deployKey && <Form.Item label="部署密钥">
              <Input value={app.deployKey} readOnly aria-label="部署密钥" />
              <div className={styles.formTip}>部署密钥不可修改</div>
            </Form.Item>}
            <Form.Item>
              <Space>
                <Button type="primary" htmlType="submit" loading={submitting}>保存修改</Button>
                <Button onClick={resetForm}>重置</Button>
                <Button type="link" onClick={() => router.push('/app/chat/' + id)}>进入对话</Button>
              </Space>
            </Form.Item>
          </Form>}
      </Card>
      {app && <Card title="应用信息" className={styles.infoCard}>
        <Descriptions column={2} bordered items={infoItems} />
      </Card>}
    </div>}
  </main>;
}
