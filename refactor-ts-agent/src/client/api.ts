'use client';
import type { ApiResult } from '@/shared/contracts';
export async function api<T>(path:string,value?:unknown):Promise<T>{
 const response=await fetch('/api/'+path,{method:value===undefined?'GET':'POST',headers:value===undefined?undefined:{'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value),credentials:'same-origin',cache:'no-store'});
 const result=await response.json() as ApiResult<T>;if(!response.ok||result.code!==0)throw new Error(result.message||'请求失败');return result.data;
}
export function safeRedirect(input:string|null){return input?.startsWith('/')&&!input.startsWith('//')&&!input.includes('\\')?input:'/';}
