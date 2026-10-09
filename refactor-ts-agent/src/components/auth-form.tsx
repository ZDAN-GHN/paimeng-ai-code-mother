'use client';
import { useState } from 'react';
import { App, Form, Input, Button, Card } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, safeRedirect } from '@/client/api';
import { useAuth } from './providers';
export function AuthForm({register=false}:{register?:boolean}){
 const {message}=App.useApp();const {refresh}=useAuth();const router=useRouter();const [busy,setBusy]=useState(false);
 async function submit(value:{userAccount:string;userPassword:string;checkPassword?:string}){setBusy(true);try{await api(register?'user/register':'user/login',value);if(register){message.success('注册成功，请登录');router.push('/user/login');}else{await refresh();router.push(safeRedirect(new URLSearchParams(window.location.search).get('redirect')));}}catch(error){message.error((error as Error).message);}finally{setBusy(false);}}
 return <main className="auth-page"><h1 className="auth-title">{register?'用户注册':'用户登录'}</h1><Card><Form layout="vertical" onFinish={submit} requiredMark={false}><Form.Item label="账号" name="userAccount" rules={[{required:true,message:'请输入账号'},{min:4,max:256,message:'账号至少 4 位'}]}><Input aria-label="账号" prefix={<UserOutlined/>} autoComplete="username" placeholder="请输入账号"/></Form.Item><Form.Item label="密码" name="userPassword" rules={[{required:true,message:'请输入密码'},{min:8,max:128,message:'密码至少 8 位'}]}><Input.Password aria-label="密码" prefix={<LockOutlined/>} autoComplete={register?'new-password':'current-password'} placeholder="请输入密码"/></Form.Item>{register&&<Form.Item label="确认密码" name="checkPassword" dependencies={['userPassword']} rules={[{required:true,message:'请确认密码'},({getFieldValue})=>({validator:(_,value)=>value===getFieldValue('userPassword')?Promise.resolve():Promise.reject(new Error('两次密码不一致'))})]}><Input.Password aria-label="确认密码" autoComplete="new-password" placeholder="请再次输入密码"/></Form.Item>}<Button type="primary" htmlType="submit" loading={busy} block>{register?'注册':'登录'}</Button></Form><div className="auth-link">{register?'已有账号？':'还没有账号？'} <Link href={register?'/user/login':'/user/register'}>{register?'去登录':'立即注册'}</Link></div></Card></main>;
}
