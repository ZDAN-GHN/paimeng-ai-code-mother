'use client';
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { ConfigProvider, App as AntApp, Layout, Button, Dropdown, Avatar, Menu } from 'antd';
import { HomeOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { User } from '@/shared/contracts';
import { api } from '@/client/api';
const AuthContext=createContext<{user:User|null;loading:boolean;refresh:()=>Promise<void>}>({user:null,loading:true,refresh:async()=>{}});
export const useAuth=()=>useContext(AuthContext);
export function Providers({children}:{children:ReactNode}){
 const [user,setUser]=useState<User|null>(null);const [loading,setLoading]=useState(true);const pathname=usePathname();const router=useRouter();
 const refresh=useCallback(async()=>{try{setUser(await api<User>('user/get/login'));}catch{setUser(null);}finally{setLoading(false);}},[]);useEffect(()=>{void refresh();},[refresh]);
 const items=[{key:'/',icon:<HomeOutlined/>,label:'主页'},...(user?.userRole==='admin'?[{key:'/admin/userManage',label:'用户管理'},{key:'/admin/appManage',label:'应用管理'},{key:'/admin/chatManage',label:'对话管理'}]:[])];
 async function logout(){await api('user/logout',{});await refresh();router.push('/user/login');}
 return <ConfigProvider theme={{token:{colorPrimary:'#cb573e',colorInfo:'#cb573e',borderRadius:10}}}><AntApp><AuthContext.Provider value={{user,loading,refresh}}><Layout className="site-layout"><Layout.Header className="site-header"><Link className="brand" href="/"><img className="brand-logo" src="/paimeng.png" alt="派蒙"/><span>派蒙 AI 应用工坊</span></Link><Menu className="navigation" mode="horizontal" selectedKeys={[pathname]} items={items} onClick={item=>router.push(item.key)}/>{user?<Dropdown menu={{items:[{key:'logout',label:'退出登录',icon:<LogoutOutlined/>}],onClick:()=>{void logout();}}}><Button type="text"><Avatar size="small" src={user.userAvatar} icon={<UserOutlined/>}/>{user.userName||'无名'}</Button></Dropdown>:<Link href="/user/login"><Button type="primary">登录</Button></Link>}</Layout.Header><Layout.Content className="site-content">{children}</Layout.Content><Layout.Footer className="site-footer">派蒙 AI 应用工坊</Layout.Footer></Layout></AuthContext.Provider></AntApp></ConfigProvider>;
}
export function AdminGuard({children}:{children:ReactNode}){const {user,loading}=useAuth();const router=useRouter();const path=usePathname();useEffect(()=>{if(!loading&&user?.userRole!=='admin')router.replace('/user/login?redirect='+encodeURIComponent(path));},[loading,user,router,path]);if(loading)return <p className="page-container">正在验证权限…</p>;return user?.userRole==='admin'?children:<p className="page-container">需要管理员权限</p>;}
