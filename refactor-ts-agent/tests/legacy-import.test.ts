import { describe, expect, it } from 'vitest';
import { idSchema } from '@/shared/contracts';
import { legacySnapshotSchema } from '@/server/legacy-import';
describe('旧数据副本边界',()=>{
 it('保持超过 JavaScript 安全整数的 ID 精度',()=>{expect(idSchema.parse('9007199254740993')).toBe('9007199254740993');expect(()=>idSchema.parse(9007199254740993)).toThrow();expect(()=>idSchema.parse('18446744073709551616')).toThrow();});
 it('用户、应用、历史外键不完整时拒绝导入',()=>{expect(()=>legacySnapshotSchema.parse({users:[],apps:[{id:'1',userId:'2',appName:'应用',cover:null,initPrompt:'需求',codeGenType:'html',deployKey:null,deployedTime:null,priority:0,createTime:'2026-04-11 19:17:38',updateTime:'2026-04-11 19:17:38'}],chatHistory:[]})).toThrow('应用引用不存在的用户');});
 it('空的合法副本可以校验',()=>{expect(legacySnapshotSchema.parse({users:[],apps:[],chatHistory:[]})).toEqual({users:[],apps:[],chatHistory:[]});});
 it('副本重复主键在导入前被拒绝，不将不同记录静默覆盖',()=>{const user={id:'9007199254740993',userAccount:'legacy',userPassword:'a'.repeat(32),userName:null,userAvatar:null,userProfile:null,userRole:'user',createTime:'2026-01-01 00:00:00',updateTime:'2026-01-01 00:00:00'};expect(()=>legacySnapshotSchema.parse({users:[user,{...user,userAccount:'different'}],apps:[],chatHistory:[]})).toThrow('重复主键');});
 it('日期必须是实际存在的日期，同时保留合法毫秒精度',()=>{const user={id:'1',userAccount:'legacy',userPassword:'a'.repeat(32),userName:null,userAvatar:null,userProfile:null,userRole:'user',createTime:'2026-01-01 00:00:00.123',updateTime:'2026-01-01 00:00:00.123'};expect(legacySnapshotSchema.parse({users:[user],apps:[],chatHistory:[]}).users[0].createTime).toBe(user.createTime);expect(()=>legacySnapshotSchema.parse({users:[{...user,createTime:'2026-02-30 00:00:00'}],apps:[],chatHistory:[]})).toThrow('日期不合法');});
});
