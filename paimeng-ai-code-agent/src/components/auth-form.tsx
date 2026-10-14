'use client';
import { useState } from 'react';
import { App, Form, Input, Button } from 'antd';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, safeRedirect } from '@/client/api';
import { useAuth } from './providers';
export function AuthForm({register=false}:{register?:boolean}){
 const {message}=App.useApp();const {refresh}=useAuth();const router=useRouter();const [busy,setBusy]=useState(false);
 async function submit(value:{userAccount:string;userPassword:string;checkPassword?:string}){setBusy(true);try{await api(register?'user/register':'user/login',value);if(register){message.success('注册成功，请登录');router.push('/user/login');}else{await refresh();router.push(safeRedirect(new URLSearchParams(window.location.search).get('redirect')));}}catch(error){message.error((error as Error).message);}finally{setBusy(false);}}
 return <main className="auth-page"><h2 className="auth-title">{register?'派蒙 AI 应用工坊 - 用户注册':'派蒙 AI 应用工坊 - 用户登录'}</h2><div className="auth-desc">不写一行代码，生成完整应用</div><Form layout="vertical" requiredMark={false} onFinish={submit}><Form.Item name="userAccount" rules={[{required:true,message:'请输入账号'}]}><Input aria-label="账号" autoComplete="username" placeholder="请输入账号"/></Form.Item><Form.Item name="userPassword" rules={[{required:true,message:'请输入密码'},{min:8,message:register?'密码不能小于 8 位':'密码长度不能小于 8 位'}]}><Input.Password aria-label="密码" autoComplete={register?'new-password':'current-password'} placeholder="请输入密码"/></Form.Item>{register&&<Form.Item name="checkPassword" dependencies={['userPassword']} rules={[{required:true,message:'请确认密码'},{min:8,message:'密码不能小于 8 位'},({getFieldValue})=>({validator:(_,value)=>!value||value===getFieldValue('userPassword')?Promise.resolve():Promise.reject(new Error('两次输入密码不一致'))})]}><Input.Password aria-label="确认密码" autoComplete="new-password" placeholder="请确认密码"/></Form.Item>}<div className="auth-tips">{register?'已有账号？':'没有账号'} <Link href={register?'/user/login':'/user/register'}>{register?'去登录':'去注册'}</Link></div><Button type="primary" htmlType="submit" loading={busy} block>{register?'注册':'登录'}</Button></Form></main>;
}
