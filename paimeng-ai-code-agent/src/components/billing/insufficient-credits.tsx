'use client';
import Link from 'next/link';
import { Alert } from 'antd';

/**
 * 额度不足的错误条：原文用服务端 402 的文案（当前可用 Credit 是多少），再补一条真正能走下去的下一步。
 *
 * 支付通道尚未开通，所以只给「联系管理员补充额度」+ 看额度条这两条真实可用的路径，
 * 不放充值/购买按钮——那是兑现不了的入口。`onClose` 用于手动收起；不传就是不可关闭。
 */
export function InsufficientCreditsAlert({ message, onClose }: { message: string; onClose?: () => void }) {
  return <Alert
    className="insufficient-credits"
    type="warning"
    showIcon
    closable={onClose ? { onClose } : false}
    title="额度不足，无法开始新的生成"
    description={<span className="insufficient-credits-next">
      {message}
      获得额度后直接重新提交即可，这次的输入会保留。
      <Link href="/">查看我的用量与额度</Link>
    </span>}
  />;
}
