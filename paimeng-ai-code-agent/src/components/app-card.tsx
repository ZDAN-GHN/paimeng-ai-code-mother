'use client';
import { Avatar, Button, Space } from 'antd';
import Link from 'next/link';
import type { AppInfo } from '@/shared/contracts';
export function HomeAppCard({app,featured=false}:{app:AppInfo;featured?:boolean}){
 return <div className={'app-card'+(featured?' app-card--featured':'')}><div className="app-preview">{app.cover?<img src={app.cover} alt={app.appName||'应用封面'}/>:<div className="app-placeholder"><span aria-hidden="true">🤖</span></div>}<div className="app-overlay"><Space><Link href={'/app/chat/'+app.id+'?view=1'}><Button type="primary">查看对话</Button></Link>{app.deployKey?<a href={app.deployUrl??undefined} target="_blank" rel="noopener noreferrer"><Button type="default">查看作品</Button></a>:null}</Space></div></div><div className="app-info"><div className="app-info-left"><Avatar src={app.user?.userAvatar} size={40}>{app.user?.userName?.charAt(0)||'U'}</Avatar></div><div className="app-info-right"><h3 className="app-title">{app.appName||'未命名应用'}</h3><p className="app-author">{app.user?.userName||(featured?'官方':'未知用户')}</p></div></div></div>;
}
