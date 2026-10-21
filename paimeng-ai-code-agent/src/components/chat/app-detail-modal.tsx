'use client';
import { Modal, Button, Tag, Space, Avatar, Popconfirm } from 'antd';
import { EditOutlined, DeleteOutlined, UserOutlined } from '@ant-design/icons';
import type { AppInfo } from '@/shared/contracts';
import { formatStoredTime } from '@/shared/display';

const codeGenTypeLabels: Record<string, string> = {
  html: '原生 HTML 模式',
  multi_file: '原生多文件模式',
  vue_project: 'Vue项目模式',
  react_project: 'React项目模式',
};

export function formatCodeGenType(type?: string | null) {
  if (!type) return '未知类型';
  return codeGenTypeLabels[type] ?? type;
}

export function formatCreateTime(value?: string | null) {
  // 库里是 UTC 的朴素时间：按 UTC 解释再转本地，否则会显示成早 8 小时。
  return formatStoredTime(value);
}

export function AppDetailModal({ open, app, showActions, onClose, onEdit, onDelete }: {
  open: boolean;
  app: AppInfo | null;
  showActions: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const creator = app?.user;
  return <Modal open={open} title="应用详情" footer={null} width={500} onCancel={onClose}>
    <div className="app-detail-content">
      <div className="info-item">
        <span className="info-label">创建者：</span>
        <Space size={8}>
          <Avatar size="small" src={creator?.userAvatar ?? undefined} icon={<UserOutlined />} />
          <span>{creator?.userName || '未知用户'}</span>
        </Space>
      </div>
      <div className="info-item">
        <span className="info-label">创建时间：</span>
        <span>{formatCreateTime(app?.createTime)}</span>
      </div>
      <div className="info-item">
        <span className="info-label">生成类型：</span>
        {app?.codeGenType ? <Tag color="blue">{formatCodeGenType(app.codeGenType)}</Tag> : <span>未知类型</span>}
      </div>
      {app?.template && <div className="info-item"><span className="info-label">工程模板：</span><Tag>{app.template.id}@{app.template.version}</Tag></div>}
      {showActions && <div className="app-detail-actions">
        <Space>
          <Button type="primary" icon={<EditOutlined aria-hidden="true" />} onClick={onEdit}>修改</Button>
          <Popconfirm title="确定要删除这个应用吗？" okText="确定" cancelText="取消" onConfirm={onDelete}>
            <Button danger icon={<DeleteOutlined aria-hidden="true" />}>删除</Button>
          </Popconfirm>
        </Space>
      </div>}
    </div>
  </Modal>;
}
