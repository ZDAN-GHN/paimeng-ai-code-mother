import { test, expect, devices, type Page } from '@playwright/test';
import type { AppInfo, User } from '../../src/shared/contracts';
import { previewOrigin } from './support/app-origin';

const blogTemplate='创建一个现代化的个人博客网站，包含文章列表、详情页、分类标签、搜索功能、评论系统和个人简介页面。采用简洁的设计风格，支持响应式布局，文章支持Markdown格式，首页展示最新文章和热门推荐。';
const creator:User={id:'1',userAccount:'alice',userName:'爱丽丝',userAvatar:null,userProfile:null,userRole:'user',createTime:'2026-01-01 00:00:00',updateTime:'2026-01-01 00:00:00'};
const ownerApp:AppInfo={id:'11',appName:'我的博客',cover:null,initPrompt:'创建一个个人博客网站',codeGenType:'html',deployKey:null,deployedTime:null,priority:0,userId:'1',createTime:'2026-01-01 00:00:00',updateTime:'2026-01-01 00:00:00',user:creator,deployUrl:null};
const featuredApp:AppInfo={...ownerApp,id:'22',appName:'精选商城',deployKey:'html_22',deployedTime:'2026-01-02 00:00:00',deployUrl:`${previewOrigin()}/deploy/html_22/`};

function pageOf(records:AppInfo[],total=records.length){return {records,totalRow:total,pageNumber:1,pageSize:6};}
async function mockSession(page:Page,user:User|null){
  await page.route('**/api/user/get/login',route=>user?route.fulfill({json:{code:0,data:user}}):route.fulfill({status:401,json:{code:401,message:'未登录',data:null}}));
}
async function mockHome(page:Page,options:{user:User|null;my?:AppInfo[];good?:AppInfo[];myTotal?:number;goodTotal?:number}){
  await mockSession(page,options.user);
  await page.route('**/api/app/good/list/page/vo',route=>route.fulfill({json:{code:0,data:pageOf(options.good??[],options.goodTotal)}}));
  await page.route('**/api/app/my/list/page/vo',route=>route.fulfill({json:{code:0,data:pageOf(options.my??[],options.myTotal)}}));
}
async function mockChat(page:Page){
  await page.route('**/api/app/get/vo?*',route=>route.fulfill({json:{code:0,data:{...ownerApp,id:'999'}}}));
  await page.route('**/api/app/messages?*',route=>route.fulfill({json:{code:0,data:[]}}));
  await page.route('**/api/app/generation?*',route=>route.fulfill({json:{code:0,data:{id:'task-1',status:'cancelled'}}}));
}

test('模板按钮填入完整需求，创建应用只提交 initPrompt 交给后端自动选类型',async({page})=>{
  await mockHome(page,{user:creator});
  await mockChat(page);
  let payload:Record<string,unknown>|undefined;
  await page.route('**/api/app/add',async route=>{payload=route.request().postDataJSON();await route.fulfill({json:{code:0,data:'999'}});});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'AI 应用生成平台'})).toBeVisible();
  await expect(page.locator('.hero-title')).toHaveCSS('font-size','56px');
  await expect(page.locator('.hero-description')).toHaveText('一句话轻松创建网站应用');
  await expect(page.locator('.hero-description')).toHaveCSS('font-size','20px');
  await expect(page.getByRole('heading',{name:'我的作品'})).toHaveCSS('font-size','32px');
  await expect(page.getByRole('heading',{name:'精选案例'})).toBeVisible();
  await expect(page.locator('.quick-actions button')).toHaveCount(4);
  await expect(page.getByLabel('生成类型')).toHaveCount(0);
  await page.getByRole('button',{name:'个人博客网站'}).click();
  await expect(page.getByLabel('应用描述')).toHaveValue(blogTemplate);
  await page.getByRole('button',{name:'创建应用'}).click();
  await expect(page).toHaveURL(/\/app\/chat\/999$/);
  expect(payload).toEqual({initPrompt:blogTemplate});
  expect(payload).not.toHaveProperty('codeGenType');
});

test('首页展示两个分页的 N 个应用与 N 个案例总数文案',async({page})=>{
  await mockHome(page,{user:creator,my:[ownerApp],myTotal:7,good:[featuredApp],goodTotal:13});
  await page.goto('/');
  await expect(page.getByText('共 7 个应用')).toBeVisible();
  await expect(page.getByText('共 13 个案例')).toBeVisible();
});

test('匿名首页保留空作品网格与分页，未部署卡片不显示编辑',async({page})=>{
  await mockHome(page,{user:null,good:[{...featuredApp,id:'33',appName:'未部署作品',deployKey:null,deployedTime:null,deployUrl:null}]});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'我的作品'})).toBeVisible();
  await expect(page.getByText('共 0 个应用')).toBeVisible();
  const mySection=page.locator('section.section').first();
  await expect(mySection.locator('.app-card')).toHaveCount(0);
  await expect(mySection.locator('.pagination-wrapper .ant-pagination')).toBeVisible();
  await expect(page.getByText('立即登录')).toHaveCount(0);
  const goodSection=page.locator('section.section').nth(1);
  await expect(goodSection.locator('.app-card')).toHaveCount(1);
  await expect(goodSection.getByText('爱丽丝')).toBeVisible();
  await expect(page.getByRole('button',{name:'查看作品'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'编辑'})).toHaveCount(0);
  await expect(goodSection.getByRole('button',{name:'查看对话'})).toHaveCount(1);
});

test('输入区单框无类型下拉，maxLength 为 1000，图标按钮有 aria-label',async({page})=>{
  await mockHome(page,{user:null});
  await page.goto('/');
  await expect(page.getByLabel('应用描述')).toHaveAttribute('maxlength','1000');
  await expect(page.getByLabel('应用描述')).toHaveAttribute('placeholder','帮我创建个人博客网站');
  await expect(page.locator('.input-section .ant-select')).toHaveCount(0);
  await expect(page.locator('.input-actions button')).toHaveAttribute('aria-label','创建应用');
  await expect(page.locator('.input-actions button')).toHaveText('↑');
});

test('卡片操作键盘 focus-within 可见，触屏无需悬停即可操作',async({page,browser})=>{
  await mockHome(page,{user:creator,my:[ownerApp]});
  await page.goto('/');
  const card=page.locator('.app-card').first();
  await expect(card.locator('.app-overlay')).toHaveCSS('opacity','0');
  await card.hover();
  await expect(card.locator('.app-overlay')).toHaveCSS('opacity','1');
  await page.mouse.move(0,0);
  await expect(card.locator('.app-overlay')).toHaveCSS('opacity','0');
  await card.getByRole('button',{name:'查看对话'}).focus();
  await expect(card.locator('.app-overlay')).toHaveCSS('opacity','1');

  const touch=await browser.newContext({...devices['Pixel 5'],baseURL:test.info().project.use.baseURL});
  const touchPage=await touch.newPage();
  await mockHome(touchPage,{user:null,good:[featuredApp]});
  await touchPage.goto('/');
  await expect(touchPage.locator('.app-overlay').first()).toHaveCSS('opacity','1');
  await touch.close();
});

test('reduced-motion 关闭首页动画，默认播放标题动效',async({page})=>{
  await mockHome(page,{user:null});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/');
  await expect(page.locator('.hero-title')).toHaveCSS('animation-name','none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await expect(page.locator('.hero-title')).toHaveCSS('animation-name','titleShimmer');
});

test('登录页恢复 720px 品牌标题副标题右对齐提示，账号仅必填',async({page})=>{
  await mockSession(page,null);
  let requested=false;
  await page.route('**/api/user/login',route=>{requested=true;return route.fulfill({json:{code:0,data:{}}});});
  await page.goto('/user/login');
  await expect(page.locator('.auth-page')).toHaveCSS('max-width','720px');
  await expect(page.locator('.auth-title')).toContainText('派蒙 AI 应用工坊 - 用户登录');
  await expect(page.locator('.auth-desc')).toHaveText('不写一行代码，生成完整应用');
  await expect(page.locator('.auth-tips')).toHaveCSS('text-align','right');
  await page.getByLabel('账号',{exact:true}).fill('ab');
  await page.getByLabel('密码',{exact:true}).fill('password123');
  await page.locator('form').getByRole('button',{name:/^登\s*录$/}).click();
  await expect.poll(()=>requested).toBe(true);
});

test('注册页保留原校验：密码不足 8 位给出提示',async({page})=>{
  await mockSession(page,null);
  await page.goto('/user/register');
  await expect(page.locator('.auth-title')).toContainText('派蒙 AI 应用工坊 - 用户注册');
  await page.getByLabel('账号',{exact:true}).fill('ab');
  await page.getByLabel('密码',{exact:true}).fill('short');
  await page.getByLabel('确认密码',{exact:true}).fill('short');
  await page.locator('form').getByRole('button',{name:/^注\s*册$/}).click();
  await expect(page.getByText('密码不能小于 8 位').first()).toBeVisible();
});
