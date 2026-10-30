import { z } from 'zod';
import { getConfig } from './config';
export class BusinessError extends Error {constructor(public status:number,public code:number,message:string){super(message);}}
export function success<T>(data:T){return Response.json({code:0,data,message:'ok'},{headers:{'Cache-Control':'no-store'}});}
export function failure(error:unknown){
 const headers={'Cache-Control':'no-store'};
 if(error instanceof BusinessError) return Response.json({code:error.code,data:null,message:error.message},{status:error.status,headers});
 if(error instanceof z.ZodError) return Response.json({code:40000,data:null,message:error.issues[0]?.message??'参数错误'},{status:400,headers});
 console.error('Request failed',error);
 return Response.json({code:50000,data:null,message:'服务处理失败，请稍后重试'},{status:500,headers});
}
const heartbeatIntervalMs=1000;
// 部署/构建几十秒内没有响应字节时，Firefox 会在链路状态变化后关掉这条「无流量」连接；慢路径每 1s 写一个前导空白字节（JSON.parse 允许），客户端解析逻辑不变。
export async function withHeartbeat(work:()=>Promise<Response>){
 const encoder=new TextEncoder();
 const settled=work().then(response=>({response}),error=>({error}));
 const first=await Promise.race([settled,new Promise<null>(resolve=>{setTimeout(()=>resolve(null),heartbeatIntervalMs);})]);
 if(first!==null)return 'response' in first?first.response:failure(first.error);
 return new Response(new ReadableStream<Uint8Array>({
  async start(controller){
   const beat=setInterval(()=>{try{controller.enqueue(encoder.encode('\n'));}catch{}},heartbeatIntervalMs);
   try{
    const outcome=await settled;
    controller.enqueue(encoder.encode(await ('response' in outcome?outcome.response:failure(outcome.error)).text()));
   }finally{clearInterval(beat);controller.close();}
  },
 }),{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'}});
}
// JSON 通道的请求体上限，按实际 UTF-8 字节数算，不认 content-length 的声明。
// multipart 通道（附件上传、语音转写）在 guardRequest 之前分流，上限各自实现。
const maxBodyBytes=100000;
// 读写都要求精确匹配 APP_ORIGIN：预览跑在另一个主机名，127.0.0.1 这类别名也不能发起写请求。
export function guardRequest(req:Request){
 const config=getConfig();
 if(new URL(req.url).origin!==config.appOrigin) throw new BusinessError(403,40300,'管理接口来源不合法');
 if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.get('origin')!==config.appOrigin) throw new BusinessError(403,40300,'写请求必须来自管理界面');
 if(Number(req.headers.get('content-length')??0)>maxBodyBytes) throw new BusinessError(413,40000,'请求过大');
}
export async function body(req:Request){
 if(!req.body)return {};
 const reader=req.body.getReader();const decoder=new TextDecoder();let size=0;let raw='';
 try{
  while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maxBodyBytes){await reader.cancel();throw new BusinessError(413,40000,'请求过大');}raw+=decoder.decode(next.value,{stream:true});}
  raw+=decoder.decode();
 }finally{reader.releaseLock();}
 try{return JSON.parse(raw||'{}') as unknown;}catch{throw new BusinessError(400,40000,'JSON 格式错误');}
}
