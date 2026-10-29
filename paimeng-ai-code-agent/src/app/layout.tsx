import { ReticleDev } from './reticle-dev';
import type { Metadata } from 'next';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { Providers } from '@/components/providers';
import './globals.css';
export const metadata:Metadata={title:'派蒙 AI 应用工坊',description:'一句话创建网站应用'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{process.env.NODE_ENV === 'development' ? <ReticleDev /> : null}<AntdRegistry><Providers>{children}</Providers></AntdRegistry></body></html>;}
