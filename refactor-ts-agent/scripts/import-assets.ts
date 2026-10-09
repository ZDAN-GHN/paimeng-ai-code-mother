import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const source=resolve('../paimeng-ai-code-mother-frontend/src/assets/paimeng.png');
await mkdir('public',{recursive:true});await copyFile(source,resolve('public/paimeng.png'));
console.log('已复制原品牌图片至新应用，原文件未修改');
