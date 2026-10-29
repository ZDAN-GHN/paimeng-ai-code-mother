import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../../..');
const diff=execFileSync('git',['diff','--binary','--','.',':!paimeng-ai-code-agent',':!.agents',':!.github/workflows/tests.yml'],{cwd:root,maxBuffer:16*1024*1024});
const actual=createHash('sha256').update(diff).digest('hex');
// 2026-10-14 重冻结：旧代码归档到 archive/、项目目录改名为 paimeng-ai-code-agent/ 之后，项目目录外的未提交差异应恒为空。
const expected='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
if(actual!==expected) throw new Error('项目目录外存在未提交的已跟踪文件改动');
const untracked=execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:root}).toString().trim().split('\n').filter(Boolean);
// 仓库根的 .agents/ 是 agent 侧的验证技能（跨目录使用，不属于产品代码）；它的证据目录已在 .git/info/exclude 里。
const allowedPrefixes=['paimeng-ai-code-agent/','.agents/'];
const allowedFiles=new Set(['.github/workflows/tests.yml','GLOSSARY.md']);
if(untracked.some(p=>!allowedPrefixes.some(prefix=>p.startsWith(prefix))&&!allowedFiles.has(p))) throw new Error('项目目录外存在未跟踪文件，请核对是否为用户改动');
console.log('项目目录外的未提交改动与基线一致');
