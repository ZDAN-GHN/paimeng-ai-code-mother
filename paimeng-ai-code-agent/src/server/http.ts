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
const maxBodyBytes=100000;
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
