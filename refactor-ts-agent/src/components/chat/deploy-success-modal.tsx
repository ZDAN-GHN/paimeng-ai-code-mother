'use client';
import { Modal, Button, Input, App } from 'antd';
import { CheckCircleOutlined, CopyOutlined } from '@ant-design/icons';

// clipboard.writeText needs a secure context and permission; the hidden textarea
// path keeps the copy button working when the async API is unavailable.
async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return true; } catch { /* fall through */ }
  }
  const helper = document.createElement('textarea');
  helper.value = value;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.appendChild(helper);
  try {
    helper.select();
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(helper);
  }
}

export function DeploySuccessModal({ open, deployUrl, onClose, onOpenSite }: {
  open: boolean;
  deployUrl: string;
  onClose: () => void;
  onOpenSite: () => void;
}) {
  const { message } = App.useApp();
  async function copy() {
    try {
      const copied = await writeClipboard(deployUrl);
      if (copied) message.success('链接已复制到剪贴板');
      else message.error('复制失败');
    } catch {
      message.error('复制失败');
    }
  }
  return <Modal open={open} title="部署成功" footer={null} width={600} onCancel={onClose}>
    <div className="deploy-success">
      <div className="deploy-success-icon"><CheckCircleOutlined aria-hidden="true" /></div>
      <h3>网站部署成功！</h3>
      <p>你的网站已经成功部署，可以通过以下链接访问：</p>
      <Input readOnly value={deployUrl} aria-label="部署链接" suffix={<Button type="text" aria-label="复制部署链接" icon={<CopyOutlined />} onClick={() => { void copy(); }} />} />
      <div className="deploy-success-actions">
        <Button type="primary" onClick={onOpenSite}>访问网站</Button>
        <Button onClick={onClose}>关闭</Button>
      </div>
    </div>
  </Modal>;
}
