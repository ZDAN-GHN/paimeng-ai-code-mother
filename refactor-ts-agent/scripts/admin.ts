import mysql from 'mysql2/promise';
const url=new URL(process.env.DATABASE_URL??'');
if(!/^paimeng_ai_code_mother_ts(?:_test)?$/.test(url.pathname.slice(1)))throw new Error('仅允许修改独立 TS 库');
const account=process.argv[2];if(!account)throw new Error('用法 npm run db:admin -- 已注册账号');
const connection=await mysql.createConnection(url.href);
try{const [result]=await connection.execute<mysql.ResultSetHeader>("UPDATE user SET userRole='admin' WHERE userAccount=? AND isDelete=0",[account]);if(result.affectedRows!==1)throw new Error('账号不存在');console.log('独立 TS 库管理员设置完成');}finally{await connection.end();}
