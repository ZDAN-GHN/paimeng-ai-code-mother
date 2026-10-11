'use client';
import { Avatar } from 'antd';
import styles from './user-info.module.css';

type UserSummary = { userName?: string | null; userAvatar?: string | null };

export function UserInfo({ user, size = 'small' }: { user?: UserSummary | null; size?: number | 'small' | 'default' | 'large' }) {
  return <span className={styles.userInfo}><Avatar size={size} src={user?.userAvatar || undefined}>{user?.userName?.charAt(0) || 'U'}</Avatar><span className={styles.userName}>{user?.userName || '未知用户'}</span></span>;
}
