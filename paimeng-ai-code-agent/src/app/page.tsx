'use client';
import { useEffect, useState } from 'react';
import { App, Button, Input, Pagination, Select } from 'antd';
import { useRouter } from 'next/navigation';
import { api } from '@/client/api';
import { useAuth } from '@/components/providers';
import { HomeAppCard } from '@/components/app-card';
import type { AppInfo, Page } from '@/shared/contracts';
import { codeGenTemplates } from '@/shared/templates';
const quickTemplates=[
 {label:'个人博客网站',prompt:'创建一个现代化的个人博客网站，包含文章列表、详情页、分类标签、搜索功能、评论系统和个人简介页面。采用简洁的设计风格，支持响应式布局，文章支持Markdown格式，首页展示最新文章和热门推荐。'},
 {label:'企业官网',prompt:'设计一个专业的企业官网，包含公司介绍、产品服务展示、新闻资讯、联系我们等页面。采用商务风格的设计，包含轮播图、产品展示卡片、团队介绍、客户案例展示，支持多语言切换和在线客服功能。'},
 {label:'在线商城',prompt:'构建一个功能完整的在线商城，包含商品展示、购物车、用户注册登录、订单管理、支付结算等功能。设计现代化的商品卡片布局，支持商品搜索筛选、用户评价、优惠券系统和会员积分功能。'},
 {label:'作品展示网站',prompt:'制作一个精美的作品展示网站，适合设计师、摄影师、艺术家等创作者。包含作品画廊、项目详情页、个人简历、联系方式等模块。采用瀑布流或网格布局展示作品，支持图片放大预览和作品分类筛选。'},
];
const emptyPage:Page<AppInfo>={records:[],totalRow:0,pageNumber:1,pageSize:6};
export default function Home(){
 const {user}=useAuth();const {message}=App.useApp();const router=useRouter();
 const [prompt,setPrompt]=useState('');const [creating,setCreating]=useState(false);
 const [templateId,setTemplateId]=useState<string>('auto');
 const [my,setMy]=useState<Page<AppInfo>>(emptyPage);const [good,setGood]=useState<Page<AppInfo>>(emptyPage);
 async function loadMy(page=1){if(!user)return;try{setMy(await api<Page<AppInfo>>('app/my/list/page/vo',{pageNum:page,pageSize:6}));}catch(error){message.error((error as Error).message);}}
 async function loadGood(page=1){try{setGood(await api<Page<AppInfo>>('app/good/list/page/vo',{pageNum:page,pageSize:6}));}catch(error){message.error((error as Error).message);}}
 useEffect(()=>{void loadGood();},[]);
 useEffect(()=>{if(user)void loadMy();else setMy(emptyPage);},[user]);
 useEffect(()=>{function handleMouseMove(event:MouseEvent){document.documentElement.style.setProperty('--mouse-x',`${(event.clientX/window.innerWidth)*100}%`);document.documentElement.style.setProperty('--mouse-y',`${(event.clientY/window.innerHeight)*100}%`);}document.addEventListener('mousemove',handleMouseMove);return ()=>document.removeEventListener('mousemove',handleMouseMove);},[]);
 async function create(){
  if(!prompt.trim()){message.warning('请输入应用描述');return;}
  if(!user){router.push('/user/login');return;}
  setCreating(true);
  try{const id=await api<string>('app/add',{initPrompt:prompt.trim(),...(templateId==='auto'?{}:{templateId})});router.push('/app/chat/'+id);}
  catch(error){message.error((error as Error).message);}
  finally{setCreating(false);}
 }
 return <div id="homePage"><div className="container">
  <div className="hero-section"><h1 className="hero-title">AI 应用生成平台</h1><p className="hero-description">一句话轻松创建网站应用</p></div>
  <div className="template-picker"><label htmlFor="project-template">技术栈</label><Select id="project-template" aria-label="技术栈" value={templateId} onChange={setTemplateId} disabled={creating} options={[{value:'auto',label:'自动选择'},...codeGenTemplates.map(template=>({value:template.id,label:template.name}))]}/><span>{templateId==='auto'?'根据需求自动选择技术栈（AI 路由）':codeGenTemplates.find(template=>template.id===templateId)?.description}</span></div>
  <div className="input-section"><Input.TextArea className="prompt-input" aria-label="应用描述" placeholder="帮我创建个人博客网站" value={prompt} onChange={e=>setPrompt(e.target.value)} rows={4} maxLength={1000}/><div className="input-actions"><Button className="create-button" type="primary" size="large" aria-label="创建应用" loading={creating} onClick={()=>{void create();}}>↑</Button></div></div>
  <div className="quick-actions">{quickTemplates.map(item=><Button key={item.label} onClick={()=>setPrompt(item.prompt)}>{item.label}</Button>)}</div>
  <section className="section"><h2 className="section-title">我的作品</h2><div className="app-grid">{my.records.map(app=><HomeAppCard key={app.id} app={app}/>)}</div><div className="pagination-wrapper"><Pagination current={my.pageNumber} pageSize={my.pageSize} total={my.totalRow} showSizeChanger={false} showTotal={total=>`共 ${total} 个应用`} onChange={page=>{void loadMy(page);}}/></div></section>
  <section className="section"><h2 className="section-title">精选案例</h2><div className="app-grid">{good.records.map(app=><HomeAppCard key={app.id} app={app} featured/>)}</div><div className="pagination-wrapper"><Pagination current={good.pageNumber} pageSize={good.pageSize} total={good.totalRow} showSizeChanger={false} showTotal={total=>`共 ${total} 个案例`} onChange={page=>{void loadGood(page);}}/></div></section>
 </div></div>;
}
