import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { rm, symlink, readFile, writeFile } from 'node:fs/promises';
import { ensureWorkspace, workspace, writeProjectFile, readProjectFile, listProjectFiles, safeRelativePath, MAX_FILE_BYTES, MAX_PROJECT_BYTES, MAX_PROJECT_FILES } from '@/server/workspace';
const app = { id: String(Date.now()), codeGenType: 'html' as const };
const byteQuota = { ...app, id: String(BigInt(app.id) + 1n) };
const countQuota = { ...app, id: String(BigInt(app.id) + 2n) };
afterAll(async () => {
  for (const sample of [app, byteQuota, countQuota]) await rm(workspace(sample), { recursive: true, force: true });
});
describe('真实工作目录与文件工具', () => {
  it('拒绝遍历、绝对路径、环境文件与构建目录', () => {
    for (const path of ['../secret', '/etc/passwd', 'x/../../secret', 'C:\\secret', 'x\\y', '.env', '.env.local', 'node_modules/x', 'dist/index.html', 'x\0y']) expect(() => safeRelativePath(path)).toThrow();
  });
  it('写入与读取有真实文件结果', async () => {
    await writeProjectFile(app, 'src/index.html', '<h1>旧标题</h1>');
    expect(await readProjectFile(app, 'src/index.html')).toBe('<h1>旧标题</h1>');
    await writeProjectFile(app, 'src/index.html', '<h1>新标题</h1>');
    expect(await readFile(join(workspace(app), 'src/index.html'), 'utf8')).toBe('<h1>新标题</h1>');
    expect(await listProjectFiles(app)).toEqual(['src/index.html']);
  });
  it('拒绝文件与中间目录软链接，不能读取宿主文件', async () => {
    const root = await ensureWorkspace(app);
    await symlink('/etc/passwd', join(root, 'link.txt'));
    await expect(readProjectFile(app, 'link.txt')).rejects.toThrow();
    await expect(writeProjectFile(app, 'link.txt', 'x')).rejects.toThrow();
    await rm(join(root, 'link.txt'));
    await symlink('/tmp', join(root, 'escape'));
    await expect(writeProjectFile(app, 'escape/host.txt', 'x')).rejects.toThrow();
    await rm(join(root, 'escape'));
  });
  it('限制单文件大小', async () => {
    await expect(writeProjectFile(app, 'huge.txt', 'x'.repeat(MAX_FILE_BYTES + 1))).rejects.toThrow('超过限制');
  });
  it('总字节达到上限后拒绝新增，原文件仍可等大小替换或缩小', async () => {
    const root = await ensureWorkspace(byteQuota);
    const content = 'x'.repeat(MAX_FILE_BYTES);
    for (let index = 0; index < MAX_PROJECT_BYTES / MAX_FILE_BYTES; index++) await writeFile(join(root, `${index}.txt`), content);
    await expect(writeProjectFile(byteQuota, 'overflow.txt', 'x')).rejects.toThrow('工程超过');
    await expect(readFile(join(root, 'overflow.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeProjectFile(byteQuota, '0.txt', 'y'.repeat(MAX_FILE_BYTES));
    expect(await readProjectFile(byteQuota, '0.txt')).toBe('y'.repeat(MAX_FILE_BYTES));
    await writeProjectFile(byteQuota, '0.txt', 'y');
    await writeProjectFile(byteQuota, 'added.txt', 'z');
    expect(await readProjectFile(byteQuota, 'added.txt')).toBe('z');
  });
  it('文件数量达到上限后拒绝新增，但允许替换已有文件', async () => {
    const root = await ensureWorkspace(countQuota);
    for (let index = 0; index < MAX_PROJECT_FILES; index++) await writeFile(join(root, `${index}.txt`), 'x');
    await expect(writeProjectFile(countQuota, 'overflow.txt', 'x')).rejects.toThrow('工程超过');
    expect(await listProjectFiles(countQuota)).toHaveLength(MAX_PROJECT_FILES);
    await expect(readFile(join(root, 'overflow.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeProjectFile(countQuota, '0.txt', 'replacement');
    expect(await readProjectFile(countQuota, '0.txt')).toBe('replacement');
  });
});
