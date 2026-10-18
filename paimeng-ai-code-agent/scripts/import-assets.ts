/** 一次性品牌素材迁移；不属于日常启动或测试入口，使用条件见 scripts/README.md。 */
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const source=resolve('../archive/paimeng-ai-code-mother-frontend/src/assets/paimeng.png');
await mkdir('public',{recursive:true});await copyFile(source,resolve('public/paimeng.png'));
console.log('已复制原品牌图片至新应用，原文件未修改');
