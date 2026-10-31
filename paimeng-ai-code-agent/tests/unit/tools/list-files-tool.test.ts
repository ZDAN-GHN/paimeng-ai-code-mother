import { describe, expect, it } from 'vitest';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { listFilesTool } from '@/server/generation/tools/list-files-tool';

type Entry = { name: string; kind: 'file' | 'directory' | 'symlink' };

/** 只实现 listFiles 用到的 listDir；执行环境在 harness 里由模型工具运行时提供。 */
function apiWith(tree: Record<string, Entry[]>) {
  return {
    env: { listDir: async (directory: string) => ({ ok: true as const, value: tree[directory] ?? [] }) },
  } as unknown as ToolExecutionApi;
}

async function list(tree: Record<string, Entry[]>) {
  const result = await listFilesTool.execute!({}, apiWith(tree), { abortSignal: undefined } as never);
  return (result as { details: { files: string[] } }).details.files;
}

describe('listFiles 工具', () => {
  it('返回相对路径：目录带 / 结尾，并跳过依赖与构建产物目录', async () => {
    const files = await list({
      '': [
        { name: 'src', kind: 'directory' },
        { name: 'index.html', kind: 'file' },
        { name: 'node_modules', kind: 'directory' },
        { name: 'dist', kind: 'directory' },
      ],
      src: [{ name: 'main.ts', kind: 'file' }],
    });
    expect(files).toEqual(['src/', 'src/main.ts', 'index.html']);
  });

  it('一次最多列 300 个条目，防止大工程撑爆工具结果', async () => {
    const tree = { '': Array.from({ length: 350 }, (_, index) => ({ name: `f${index}.html`, kind: 'file' as const })) };
    expect(await list(tree)).toHaveLength(300);
  });

  it('没有执行环境时直接报错，而不是返回空列表', async () => {
    await expect(listFilesTool.execute!({}, {} as ToolExecutionApi, {} as never)).rejects.toThrow('这次工具调用没有可用的执行环境');
  });
});
