import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertExecution,
  cleanupExecution,
  closeExecutionAndDrain,
  executionDirectory,
  executionTarget,
  markExecutionFailed,
  openExecution,
  prepareExecution,
  sealExecution,
  withExecutionWrite,
} from '@/server/workspace/execution-workspace';
import { readProjectFile, writeProjectFile } from '@/server/workspace/workspace';

/**
 * 隔离执行目录与草稿封存：只写盘，不连数据库。
 * 所有 runtimeRoot 都在 /tmp 下临时创建，绝不碰仓库里的真实 runtime。
 */

const app = { id: '1001', codeGenType: 'html' as const };
let base: string;
let runtimeRoot: string;
let snapshotsRoot: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'paimeng-execution-')));
  runtimeRoot = join(base, 'runtime');
  snapshotsRoot = join(base, 'snapshots');
  await mkdir(runtimeRoot);
  await mkdir(snapshotsRoot);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 独立按「相对路径排序 + 路径 + 字节 + 长度」重算摘要，验证实现没有偷换顺序或漏算文件。 */
async function expectedDigest(root: string) {
  const files: string[] = [];
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), rel);
      else if (entry.isFile() && rel !== 'manifest.json') files.push(rel);
    }
  }
  await walk(root, '');
  files.sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    const data = await readFile(join(root, rel));
    hash.update(`file:${rel}:${data.byteLength}\n`);
    hash.update(data);
  }
  return hash.digest('hex');
}

describe('执行目录定位', () => {
  it('固定为 executions/<generationId>/<epoch>，默认用配置的 runtimeRoot', () => {
    expect(executionDirectory(app, 'gen_1-a', 2, '/srv/runtime')).toBe('/srv/runtime/executions/gen_1-a/2');
    expect(executionDirectory(app, 'gen-default', 1)).toBe(join(process.cwd(), 'runtime', 'executions', 'gen-default', '1'));
  });

  it('拒绝不安全 generationId、非正整数 epoch 与任何越界写法', () => {
    for (const generationId of ['../escape', '/abs', 'a/b', '..', '', 'a..b', 'a b', 'a.b', '.hidden', 'g'.repeat(129)]) {
      expect(() => executionDirectory(app, generationId, 1, '/srv/runtime')).toThrow('非法的 generation 标识');
    }
    for (const epoch of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => executionDirectory(app, 'gen', epoch, '/srv/runtime')).toThrow('执行编号必须是正整数');
    }
    expect(() => executionDirectory({ ...app, codeGenType: 'nope' as never }, 'gen', 1, '/srv/runtime')).toThrow();
  });

  it('prepareExecution 不会把越界标识落到执行区之外', async () => {
    await expect(prepareExecution({ app, generationId: '../outside', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot })).rejects.toThrow('非法的 generation 标识');
    expect(existsSync(join(dirname(runtimeRoot), 'outside'))).toBe(false);
    expect(existsSync(join(runtimeRoot, 'executions', 'outside'))).toBe(false);
  });
});

describe('基线准备', () => {
  it('模板基线用 initializeTemplate 铺目录，重复准备同一目录被拒绝', async () => {
    const ref = await prepareExecution({ app, generationId: 'gen-template', epoch: 1, baseline: { kind: 'template', identity: { id: 'html', version: '1.0.0' } }, runtimeRoot });
    expect(ref).toEqual({ root: join(runtimeRoot, 'executions', 'gen-template', '1'), generationId: 'gen-template', epoch: 1 });
    const target = executionTarget(app, ref);
    expect(target).toEqual({ app, root: ref.root });
    expect(await readProjectFile(target, 'index.html')).toContain('<html');
    // 显式根确实就是执行目录，而不是共享工作区。
    await writeProjectFile(target, 'src/only-here.css', 'body{}');
    expect(await readFile(join(ref.root, 'src/only-here.css'), 'utf8')).toBe('body{}');
    await expect(prepareExecution({ app, generationId: 'gen-template', epoch: 1, baseline: { kind: 'template', identity: { id: 'html', version: '1.0.0' } }, runtimeRoot })).rejects.toThrow('执行目录已存在且非空，不能覆盖');
    await expect(prepareExecution({ app, generationId: 'gen-template', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot })).rejects.toThrow('执行目录已存在且非空，不能覆盖');
  });

  it('目录基线过滤依赖/产物/环境变量/平台文件，并拒绝符号链接', async () => {
    const source = join(base, 'baseline-source');
    await mkdir(join(source, 'src'), { recursive: true });
    await mkdir(join(source, 'public'), { recursive: true });
    await mkdir(join(source, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(source, 'dist'), { recursive: true });
    await mkdir(join(source, '.git'), { recursive: true });
    await writeFile(join(source, 'index.html'), '<html><body>draft</body></html>');
    await writeFile(join(source, 'src', 'style.css'), 'body{}');
    await writeFile(join(source, 'node_modules', 'pkg', 'index.js'), 'noise');
    await writeFile(join(source, 'dist', 'index.html'), 'noise');
    await writeFile(join(source, '.git', 'config'), 'noise');
    await writeFile(join(source, '.env.local'), 'SECRET=1');
    await writeFile(join(source, '.paimeng-build.json'), '{}');
    await writeFile(join(source, 'manifest.json'), '{"version":1}');
    await writeFile(join(source, 'public', 'manifest.json'), '{"name":"nested"}');
    const ref = await prepareExecution({ app, generationId: 'gen-directory', epoch: 1, baseline: { kind: 'directory', directory: source }, runtimeRoot });
    const target = executionTarget(app, ref);
    expect(await readProjectFile(target, 'index.html')).toBe('<html><body>draft</body></html>');
    expect(await readProjectFile(target, 'src/style.css')).toBe('body{}');
    expect((await readdir(ref.root)).sort()).toEqual(['index.html', 'public', 'src']);
    expect(existsSync(join(ref.root, 'manifest.json'))).toBe(false);
    expect(await readProjectFile(target, 'public/manifest.json')).toBe('{"name":"nested"}');

    await symlink(join(source, 'index.html'), join(source, 'linked.html'));
    await expect(prepareExecution({ app, generationId: 'gen-directory', epoch: 2, baseline: { kind: 'directory', directory: source }, runtimeRoot })).rejects.toThrow('不允许包含符号链接');
    // 失败后不留半成品目录。
    expect(existsSync(join(runtimeRoot, 'executions', 'gen-directory', '2'))).toBe(false);
    await expect(prepareExecution({ app, generationId: 'gen-directory', epoch: 3, baseline: { kind: 'directory', directory: join(base, 'missing') }, runtimeRoot })).rejects.toThrow('基线目录不存在');
  });

  it('版本基线先建空目录，再由调用方用 version-store 物化', async () => {
    let observed: string | undefined;
    const ref = await prepareExecution({
      app,
      generationId: 'gen-version',
      epoch: 1,
      baseline: {
        kind: 'version',
        commitSha: 'a'.repeat(40),
        materialize: async target => {
          observed = target;
          expect(await readdir(target)).toEqual([]);
          await writeFile(join(target, 'index.html'), '<html><body>v1</body></html>');
        },
      },
      runtimeRoot,
    });
    expect(observed).toBe(ref.root);
    expect(await readProjectFile(executionTarget(app, ref), 'index.html')).toContain('v1');
    await expect(prepareExecution({ app, generationId: 'gen-version', epoch: 2, baseline: { kind: 'version', commitSha: 'not-a-sha', materialize: async () => {} }, runtimeRoot })).rejects.toThrow('非法的提交标识');
    await expect(prepareExecution({ app, generationId: 'gen-version', epoch: 3, baseline: { kind: 'version', commitSha: 'b'.repeat(40), materialize: async () => { throw new Error('物化失败'); } }, runtimeRoot })).rejects.toThrow('物化失败');
    expect(existsSync(join(runtimeRoot, 'executions', 'gen-version', '3'))).toBe(false);
  });
});

describe('写入门闩', () => {
  it('关门后等待在途写入退出，期间与之后都拒绝新写入', async () => {
    const ref = await prepareExecution({ app, generationId: 'gen-gate', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot });
    await openExecution(ref);
    let releaseWrite!: () => void;
    const hold = new Promise<void>(resolveHold => { releaseWrite = resolveHold; });
    const write = withExecutionWrite(ref, async () => {
      await hold;
      await writeProjectFile(executionTarget(app, ref), 'index.html', '<html><body>gate</body></html>');
    });
    let drained = false;
    const closing = closeExecutionAndDrain(ref).then(() => { drained = true; });
    // 让出事件循环，确认关门不会立刻完成。
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
    expect(drained).toBe(false);
    await expect(withExecutionWrite(ref, async () => 'x')).rejects.toThrow('执行目录已停止写入');
    releaseWrite();
    await write;
    await closing;
    expect(drained).toBe(true);
    expect(await readProjectFile(executionTarget(app, ref), 'index.html')).toContain('gate');
    await closeExecutionAndDrain(ref);
    await expect(withExecutionWrite(ref, async () => 'x')).rejects.toThrow('执行目录已停止写入');
  });

  it('排空超时抛错且门保持关闭，writer 退出后仍能完成关闸', async () => {
    const ref = await prepareExecution({ app, generationId: 'gen-gate-timeout', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot });
    await openExecution(ref);
    let releaseWrite!: () => void;
    const hold = new Promise<void>(resolveHold => { releaseWrite = resolveHold; });
    const write = withExecutionWrite(ref, async () => { await hold; });
    await expect(closeExecutionAndDrain(ref, 20)).rejects.toThrow('等待执行目录写入排空超时');
    await expect(withExecutionWrite(ref, async () => 'x')).rejects.toThrow('执行目录已停止写入');
    releaseWrite();
    await write;
    await closeExecutionAndDrain(ref, 5000);
    await closeExecutionAndDrain(ref, 5000);
  });

  it('未开门的执行目录不接受写入', async () => {
    const ref = await prepareExecution({ app, generationId: 'gen-gate-closed', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot });
    await expect(withExecutionWrite(ref, async () => 'x')).rejects.toThrow('执行目录已停止写入');
  });
});

describe('草稿封存', () => {
  it('封存复制源码、排除噪音并产出可复算的稳定摘要', async () => {
    const ref = await prepareExecution({ app, generationId: 'gen-seal', epoch: 1, baseline: { kind: 'template', identity: { id: 'html', version: '1.0.0' } }, runtimeRoot });
    const target = executionTarget(app, ref);
    await writeProjectFile(target, 'index.html', '<html><body>封存</body></html>');
    await writeProjectFile(target, 'src/extra.css', 'body{color:red}');
    await mkdir(join(ref.root, 'node_modules'), { recursive: true });
    await writeFile(join(ref.root, 'node_modules', 'noise.js'), 'noise');
    await mkdir(join(ref.root, 'dist'), { recursive: true });
    await writeFile(join(ref.root, 'dist', 'index.html'), 'noise');
    await openExecution(ref);
    await closeExecutionAndDrain(ref);

    const first = await sealExecution({ app, ref, snapshotsRoot, generationId: 'gen-seal' });
    expect(first.snapshotId).toBe('gen-seal_1');
    expect(first.directory).toBe(join(snapshotsRoot, 'html_1001', 'gen-seal_1'));
    expect(first.files).toBe(3);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.digest).toBe(await expectedDigest(first.directory));
    expect(await readFile(join(first.directory, 'index.html'), 'utf8')).toBe('<html><body>封存</body></html>');
    expect(await readFile(join(first.directory, 'src/extra.css'), 'utf8')).toBe('body{color:red}');
    expect((await readdir(first.directory)).sort()).toEqual(['AGENTS.md', 'index.html', 'manifest.json', 'src']);
    expect(JSON.parse(await readFile(join(first.directory, 'manifest.json'), 'utf8'))).toEqual({
      version: 1, digest: first.digest, files: 3, createdAt: expect.any(String),
    });

    // 重复封存同一次执行：显式 generationId 的最终目录已存在，直接拒绝。
    await expect(sealExecution({ app, ref, snapshotsRoot, generationId: 'gen-seal' })).rejects.toThrow('快照目录已存在');
    await expect(sealExecution({ app, ref, snapshotsRoot, generationId: 'other' })).rejects.toThrow('执行目录与 generation 不匹配');

    // 内容不变时摘要稳定，换一个快照 id 也一样。
    const again = await sealExecution({ app, ref, snapshotsRoot });
    expect(again.directory).not.toBe(first.directory);
    expect(again.digest).toBe(first.digest);
    expect(again.files).toBe(first.files);

    // 内容变化后摘要随之变化。
    await writeProjectFile(target, 'src/extra.css', 'body{color:blue}');
    const changed = await sealExecution({ app, ref, snapshotsRoot });
    expect(changed.digest).not.toBe(first.digest);
  });

  it('并发封存同一执行使用独立临时目录，最终只有一个快照落地', async () => {
    const ref = await prepareExecution({ app, generationId: 'gen-seal-concurrent', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot });
    await writeProjectFile(executionTarget(app, ref), 'index.html', '<html><body>并发封存</body></html>');
    await openExecution(ref);
    await closeExecutionAndDrain(ref);

    const outcomes = await Promise.allSettled([
      sealExecution({ app, ref, snapshotsRoot, generationId: 'gen-seal-concurrent' }),
      sealExecution({ app, ref, snapshotsRoot, generationId: 'gen-seal-concurrent' }),
    ]);
    const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof sealExecution>>> => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/快照目录已存在|ENOTEMPTY/);
    const directory = fulfilled[0].value.directory;
    expect(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).toMatchObject({ version: 1, files: 1, digest: fulfilled[0].value.digest });
  });

  it('封存必须先关闸；空目录也能封存为空摘要', async () => {
    const ref = await prepareExecution({ app, generationId: 'gen-seal-empty', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot });
    await openExecution(ref);
    await expect(sealExecution({ app, ref, snapshotsRoot })).rejects.toThrow('执行目录仍在写入，不能封存');
    await closeExecutionAndDrain(ref);
    const snapshot = await sealExecution({ app, ref, snapshotsRoot });
    expect(snapshot.files).toBe(0);
    expect(snapshot.digest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(JSON.parse(await readFile(join(snapshot.directory, 'manifest.json'), 'utf8'))).toMatchObject({ version: 1, files: 0, digest: snapshot.digest });
  });

  it('封存拒绝符号链接与平台保留名称', async () => {
    const linked = await prepareExecution({ app, generationId: 'gen-seal-link', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot });
    await writeFile(join(linked.root, 'index.html'), '<html></html>');
    await symlink('/etc/passwd', join(linked.root, 'leak.txt'));
    await closeExecutionAndDrain(linked);
    await expect(sealExecution({ app, ref: linked, snapshotsRoot })).rejects.toThrow('不允许包含符号链接');

    const reserved = await prepareExecution({ app, generationId: 'gen-seal-reserved', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot });
    await writeFile(join(reserved.root, 'console.txt'), 'x');
    await writeFile(join(reserved.root, 'con.txt'), 'x');
    await closeExecutionAndDrain(reserved);
    await expect(sealExecution({ app, ref: reserved, snapshotsRoot })).rejects.toThrow('平台保留名称');
  });
});

describe('校验与回收', () => {
  it('只清理已封存或已失败、且已关闸的执行目录', async () => {
    const failed = await prepareExecution({ app, generationId: 'gen-cleanup', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot });
    await expect(cleanupExecution(failed)).rejects.toThrow('只有已封存或已失败的执行目录可以清理');
    await openExecution(failed);
    markExecutionFailed(failed);
    await expect(cleanupExecution(failed)).rejects.toThrow('执行目录仍在写入，不能清理');
    await closeExecutionAndDrain(failed);
    await cleanupExecution(failed);
    expect(existsSync(failed.root)).toBe(false);
    await expect(assertExecution(failed)).rejects.toThrow('执行目录不存在');

    const sealed = await prepareExecution({ app, generationId: 'gen-cleanup-sealed', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot });
    await openExecution(sealed);
    await closeExecutionAndDrain(sealed);
    await sealExecution({ app, ref: sealed, snapshotsRoot });
    await cleanupExecution(sealed);
    expect(existsSync(sealed.root)).toBe(false);
  });

  it('执行根被换成软链接或普通文件时拒绝', async () => {
    const ref = await prepareExecution({ app, generationId: 'gen-symlink', epoch: 1, baseline: { kind: 'empty' }, runtimeRoot });
    await rm(ref.root, { recursive: true });
    await symlink(join(base, 'elsewhere'), ref.root);
    await expect(assertExecution(ref)).rejects.toThrow('执行目录不是安全的普通目录');
    await expect(openExecution(ref)).rejects.toThrow('执行目录不是安全的普通目录');
    await rm(ref.root);
    await writeFile(ref.root, 'not a directory');
    await expect(assertExecution(ref)).rejects.toThrow('执行目录不是安全的普通目录');
  });
});
