'use client';
import { useState, useEffect } from 'react';
import { App, Button, Divider, Form, Image, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import Link from 'next/link';
import { api } from '@/client/api';
import { AdminGuard, useAuth } from './providers';
import { UserInfo } from './user-info';
import { codeGenTypeOptions, formatCodeGenType, formatTime } from '@/shared/display';
import type { Page } from '@/shared/contracts';
import styles from './admin-view.module.css';

type Mode = 'user' | 'app' | 'chat';
type Row = {
  id: string;
  userAccount?: string; userName?: string | null; userRole?: string; userProfile?: string | null; userAvatar?: string | null;
  appName?: string | null; initPrompt?: string; cover?: string | null; priority?: number; userId?: string; codeGenType?: string; deployedTime?: string | null;
  user?: { userName?: string | null; userAvatar?: string | null };
  appId?: string; message?: string; messageType?: string; createTime?: string;
};
const endpoints = { user: 'user/list/page/vo', app: 'app/admin/list/page/vo', chat: 'chatHistory/admin/list/page/vo' };
const titles = { user: '用户管理', app: '应用管理', chat: '对话管理' };
// 后端精选条件是 priority >= 99，列表展示与一键操作保持一致。
const isFeatured = (priority?: number) => (priority ?? 0) >= 99;

export function AdminPage({ mode }: { mode: Mode }) { return <AdminGuard><Manager mode={mode} /></AdminGuard>; }

function Manager({ mode }: { mode: Mode }) {
  const { user } = useAuth(); const { message, modal } = App.useApp();
  const [page, setPage] = useState<Page<Row>>({ records: [], totalRow: 0, pageNumber: 1, pageSize: 10 });
  const [pageSize, setPageSize] = useState(10);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Row | null>(null);
  const [form] = Form.useForm();

  async function load(pageNum = 1, size = pageSize, filters = query) {
    setBusy(true);
    try {
      const params = { ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value != null && String(value).trim() !== '')), pageNum, pageSize: size };
      setPage(await api<Page<Row>>(endpoints[mode], params));
      setPageSize(size);
    } catch (error) {
      message.error((error as Error).message);
    } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [mode]);

  async function remove(id: string) {
    try { await api(mode === 'user' ? 'user/delete' : 'app/admin/delete', { id }); message.success('删除成功'); await load(page.pageNumber); }
    catch (error) { message.error((error as Error).message); }
  }
  async function save(value: Record<string, unknown>) {
    if (!editing) return;
    try { await api(mode === 'user' ? 'user/update' : 'app/admin/update', { ...value, id: editing.id }); setEditing(null); message.success('更新成功'); await load(page.pageNumber); }
    catch (error) { message.error((error as Error).message); }
  }
  async function toggleFeatured(row: Row) {
    const priority = isFeatured(row.priority) ? 0 : 99;
    try { await api('app/admin/update', { id: row.id, priority }); message.success(priority === 99 ? '已设为精选' : '已取消精选'); await load(page.pageNumber); }
    catch (error) { message.error((error as Error).message); }
  }

  const userColumns: ColumnsType<Row> = [
    { title: 'ID', dataIndex: 'id', width: 120 },
    { title: '账号', dataIndex: 'userAccount' },
    { title: '用户名', dataIndex: 'userName' },
    { title: '头像', dataIndex: 'userAvatar', width: 140, render: value => value ? <Image src={value} width={120} alt="用户头像" /> : <span className={styles.textGray}>无头像</span> },
    { title: '简介', dataIndex: 'userProfile', ellipsis: true },
    { title: '用户角色', dataIndex: 'userRole', render: value => <Tag color={value === 'admin' ? 'green' : 'blue'}>{value === 'admin' ? '管理员' : '普通用户'}</Tag> },
    { title: '创建时间', dataIndex: 'createTime', render: value => formatTime(value) },
    {
      title: '操作', key: 'actions', width: 160,
      render: (_, row) => <Space><Button size="small" onClick={() => { setEditing(row); form.setFieldsValue(row); }}>编辑</Button><Popconfirm title="确认删除？" onConfirm={() => remove(row.id)}><Button size="small" danger disabled={row.id === user?.id}>删除</Button></Popconfirm></Space>,
    },
  ];

  const appColumns: ColumnsType<Row> = [
    { title: 'ID', dataIndex: 'id', width: 80, fixed: 'left' },
    { title: '应用名称', dataIndex: 'appName', width: 150, render: value => value || '未命名' },
    { title: '封面', dataIndex: 'cover', width: 100, render: value => value ? <Image src={value} width={80} height={60} alt="应用封面" /> : <div className={styles.noCover}>无封面</div> },
    { title: '初始提示词', dataIndex: 'initPrompt', width: 200, render: value => <Tooltip title={value}><div className={styles.promptText}>{value}</div></Tooltip> },
    { title: '生成类型', dataIndex: 'codeGenType', width: 100, render: value => formatCodeGenType(value) },
    { title: '优先级', dataIndex: 'priority', width: 80, render: value => isFeatured(value) ? <Tag color="gold">精选</Tag> : <span>{value || 0}</span> },
    { title: '部署时间', dataIndex: 'deployedTime', width: 160, render: value => value ? formatTime(value) : <span className={styles.textGray}>未部署</span> },
    { title: '创建者', dataIndex: 'user', width: 120, render: (_, row) => row.user ? <UserInfo user={row.user} /> : <span className={styles.textGray}>未知用户</span> },
    { title: '创建时间', dataIndex: 'createTime', width: 160, render: value => formatTime(value) },
    {
      title: '操作', key: 'actions', width: 220, fixed: 'right',
      render: (_, row) => <Space><Button size="small" type="primary" onClick={() => { setEditing(row); form.setFieldsValue(row); }}>编辑</Button><Button size="small" className={isFeatured(row.priority) ? styles.featuredBtn : undefined} onClick={() => toggleFeatured(row)}>{isFeatured(row.priority) ? '取消精选' : '精选'}</Button><Popconfirm title="确定要删除这个应用吗？" onConfirm={() => remove(row.id)}><Button size="small" danger>删除</Button></Popconfirm></Space>,
    },
  ];

  const chatColumns: ColumnsType<Row> = [
    { title: 'ID', dataIndex: 'id', width: 80, fixed: 'left' },
    {
      title: '消息内容', dataIndex: 'message', width: 300,
      render: value => <Button type="link" className={styles.messageButton} onClick={() => modal.info({ title: '完整消息', width: 800, content: <pre className={styles.fullMessage}>{value}</pre> })}>{String(value ?? '').slice(0, 60)}</Button>,
    },
    { title: '消息类型', dataIndex: 'messageType', width: 100, render: value => <Tag color={value === 'user' ? 'blue' : 'green'}>{value === 'user' ? '用户消息' : 'AI消息'}</Tag> },
    { title: '应用ID', dataIndex: 'appId', width: 120 },
    { title: '用户ID', dataIndex: 'userId', width: 120 },
    { title: '创建时间', dataIndex: 'createTime', width: 160, render: value => formatTime(value) },
    { title: '操作', key: 'actions', width: 180, fixed: 'right', render: (_, row) => <Link href={'/app/chat/' + row.appId}><Button type="primary" size="small">查看对话</Button></Link> },
  ];

  const columns = mode === 'user' ? userColumns : mode === 'app' ? appColumns : chatColumns;
  const scroll = mode === 'app' ? { x: 1200 } : mode === 'chat' ? { x: 1400 } : undefined;

  return <main className={[styles.adminPage, mode === 'chat' ? styles.chatAdminPage : ''].filter(Boolean).join(' ')}>
    <div className={styles.toolbar}><h1>{titles[mode]}</h1></div>
    <Form name={mode + '-search'} layout="inline" onFinish={value => { setQuery(value); void load(1, pageSize, value); }}>
      {mode === 'user' && <>
        <Form.Item label="账号" name="userAccount"><Input aria-label="搜索账号" placeholder="输入账号" allowClear /></Form.Item>
        <Form.Item label="用户名" name="userName"><Input aria-label="搜索用户名" placeholder="输入用户名" allowClear /></Form.Item>
        <Form.Item label="用户角色" name="userRole"><Select aria-label="用户角色" placeholder="选择角色" allowClear style={{ width: 130 }} options={[{ value: 'user', label: '普通用户' }, { value: 'admin', label: '管理员' }]} /></Form.Item>
      </>}
      {mode === 'app' && <>
        <Form.Item label="应用名称" name="appName"><Input aria-label="搜索应用" placeholder="输入应用名称" allowClear /></Form.Item>
        <Form.Item label="创建者" name="userId"><Input aria-label="用户 ID" placeholder="输入用户ID" allowClear /></Form.Item>
        <Form.Item label="生成类型" name="codeGenType"><Select aria-label="生成类型" placeholder="选择生成类型" allowClear style={{ width: 170 }} options={[{ value: '', label: '全部' }, ...codeGenTypeOptions]} /></Form.Item>
      </>}
      {mode === 'chat' && <>
        <Form.Item label="消息内容" name="message"><Input aria-label="搜索消息内容" placeholder="输入消息内容" allowClear /></Form.Item>
        <Form.Item label="消息类型" name="messageType"><Select aria-label="消息类型" placeholder="选择消息类型" allowClear style={{ width: 130 }} options={[{ value: 'user', label: '用户消息' }, { value: 'ai', label: 'AI消息' }]} /></Form.Item>
        <Form.Item label="应用ID" name="appId"><Input aria-label="应用 ID" placeholder="输入应用ID" allowClear /></Form.Item>
        <Form.Item label="用户ID" name="userId"><Input aria-label="用户 ID" placeholder="输入用户ID" allowClear /></Form.Item>
      </>}
      <Form.Item><Space><Button type="primary" htmlType="submit">搜索</Button><Button onClick={() => { void load(page.pageNumber); }}>刷新</Button></Space></Form.Item>
    </Form>
    <Divider />
    <Table<Row> rowKey="id" columns={columns} dataSource={page.records} loading={busy} scroll={scroll}
      pagination={{ current: page.pageNumber, pageSize, total: page.totalRow, showSizeChanger: true, showTotal: total => `共 ${total} 条`, onChange: (pageNum, size) => { void load(pageNum, size); } }} />
    <Modal title={mode === 'user' ? '编辑用户' : '编辑应用'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()} destroyOnHidden>
      <Form name={mode + '-edit'} form={form} layout="vertical" onFinish={save}>
        {mode === 'user' ? <>
          <Form.Item label="昵称" name="userName"><Input /></Form.Item>
          <Form.Item label="简介" name="userProfile"><Input.TextArea /></Form.Item>
          <Form.Item label="头像 URL" name="userAvatar"><Input /></Form.Item>
          <Form.Item label="角色" name="userRole"><Select options={[{ value: 'user', label: '普通用户' }, { value: 'admin', label: '管理员' }]} /></Form.Item>
        </> : <>
          <Form.Item label="应用名称" name="appName" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item label="封面 URL" name="cover"><Input /></Form.Item>
          <Form.Item label="优先级" name="priority"><InputNumber min={0} max={9999} /></Form.Item>
        </>}
      </Form>
    </Modal>
  </main>;
}
