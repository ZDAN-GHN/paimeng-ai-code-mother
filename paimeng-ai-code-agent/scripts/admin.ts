import pg from 'pg';
const url=new URL(process.env.DATABASE_URL??'');
if(!/^paimeng_app(?:_test)?$/.test(url.pathname.slice(1)))throw new Error('仅允许修改独立的 paimeng_app 库');
const account=process.argv[2];if(!account)throw new Error('用法 npm run db:admin -- 已注册账号');
const client=new pg.Client({connectionString:url.href});
await client.connect();
try{const result=await client.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1 AND is_delete=0",[account]);if(result.rowCount!==1)throw new Error('账号不存在');console.log('独立 paimeng_app 库管理员设置完成');}finally{await client.end();}
