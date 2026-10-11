'use client';
import { Modal, Button, Tag, Space, Avatar, Popconfirm } from 'antd';
import { EditOutlined, DeleteOutlined, UserOutlined } from '@ant-design/icons';
import type { AppInfo } from '@/shared/contracts';

const codeGenTypeLabels: Record<string, string> = {
  html: '原生 HTML 模式',
  multi_file: '原生多文件模式',
  vue_project: 'Vue项目模式',
};

export function formatCodeGenType(type?: string | null) {
  if (!type) return '未知类型';
  return codeGenTypeLabels[type] ?? type;
}

export function formatCreateTime(value?: string | null) {
  if (!value) return '';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN');
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
