'use client';
import { use, useEffect, useState } from 'react';
import { App, Card, Form, Input, Button, Popconfirm, Alert } from 'antd';
import { useRouter } from 'next/navigation';
import { api } from '@/client/api';
import { useAuth } from '@/components/providers';
import type { AppInfo } from '@/shared/contracts';
export default function AppEdit({params}:{params:Promise<{id:string}>}){const {id}=use(params);const {user,loading}=useAuth();const router=useRouter();const {message}=App.useApp();const [app,setApp]=useState<AppInfo|null>(null);const [error,setError]=useState('');const [form]=Form.useForm();useEffect(()=>{void api<AppInfo>('app/get/vo?id='+encodeURIComponent(id)).then(value=>{setApp(value);form.setFieldsValue(value);}).catch(e=>setError(e.message));},[id,form]);
 async function save(value:{appName:string}){try{await api('app/update',{id,...value});message.success('更新成功');router.push('/app/chat/'+id);}catch(e){message.error((e as Error).message);}}
 async function remove(){try{await api('app/delete',{id});message.success('应用已删除');router.push('/');}catch(e){message.error((e as Error).message);}}
 const canEdit=user&&user.id===app?.userId;return <main className="edit-page"><h1>编辑应用</h1>{error?<Alert type="error" title={error}/>:<Card loading={!app||loading}>{app&&!canEdit?<Alert type="warning" title="只有应用创建者可以编辑；管理员请使用应用管理页面"/>:<Form form={form} layout="vertical" onFinish={save}><Form.Item label="应用名称" name="appName" rules={[{required:true,message:'请输入应用名称'},{max:256}]}><Input aria-label="应用名称"/></Form.Item><Form.Item label="初始化需求"><Input.TextArea value={app?.initPrompt} readOnly rows={4}/></Form.Item><Form.Item label="生成类型"><Input value={app?.codeGenType} readOnly/></Form.Item><div className="toolbar"><Button type="primary" htmlType="submit">保存</Button><Button onClick={()=>router.push('/app/chat/'+id)}>返回对话</Button><Popconfirm title="确认删除应用？" onConfirm={remove}><Button danger>删除应用</Button></Popconfirm></div></Form>}</Card>}</main>;}
