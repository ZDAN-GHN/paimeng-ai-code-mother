import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import type { LanguageModelV4FilePart, LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { testDatabaseUrl } from '../test-database-url';
import { chatResponse } from '@/server/agent';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, attachments, histories, messages, generationSteps, generations, leases, rateLimits } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { generationFor, loadMessages } from '@/server/generation-store';
import { createImageAttachment, readAttachmentBytes } from '@/server/attachment-store';
import { workspace } from '@/server/workspace';
import { attachmentObjectPath } from '@/server/image-files';
import type { CodeGenType, User } from '@/shared/contracts';

/**
 * 图片输入（U2）：带附件 part 的请求把图片字节附到最后一条 user 模型消息上，别名未声明 imageInput 时直接拒绝，
 * 上传原图复制进工作区供当素材引用，历史轮次不重复发送字节（只留 [图片：文件名] 占位在 ts_chat_history）。
 * 模型边界用 ai/test 的 MockLanguageModelV4，直接 mock @/server/model 返回带 imageInput 的绑定。
 */
const control = vi.hoisted(() => ({
  imageInput: true,
  prompts: [] as LanguageModelV4Prompt[],
}));

vi.mock('@/server/model', async () => {
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const html = '<!doctype html><html><body><h1>图片输入测试页面</h1></body></html>';
  const tool = (toolName: string, input: unknown): LanguageModelV4StreamPart => ({ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) });
  const buildModel = async () => {
    let index = 0;
    return new MockLanguageModelV4({
      provider: 'local-test-fixture',
      modelId: 'fixture-image',
      doStream: async options => {
        control.prompts.push(options.prompt);
        const step = index++;
        const chunks: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
        if (step === 0) chunks.push(tool('writeFiles', { files: [{ path: 'index.html', content: html }] }), { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
        else chunks.push({ type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: '已完成。' }, { type: 'text-end', id: 'reply' }, { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage });
        return { stream: simulateReadableStream<LanguageModelV4StreamPart>({ chunks, initialDelayInMs: 1, chunkDelayInMs: 0 }) };
      },
    });
  };
  const identity = (model: Awaited<ReturnType<typeof buildModel>>) => ({ model, alias: 'codegen.default', providerId: 'local-test-fixture', modelName: 'fixture-image' });
  return {
    routeCodeGenType: async () => 'html' as const,
    modelFor: buildModel,
    modelBindingFor: async () => { const model = await buildModel(); return { model, generation: identity(model), imageInput: control.imageInput }; },
    taskModelsFor: async () => { const model = await buildModel(); return { model, generation: identity(model), imageInput: control.imageInput, summary: null, summaryUnavailableReason: '测试不整理历史' }; },
  };
});

// 构建与指纹用受控实现：本用例只验证图片输入边界，不跑真实容器构建（也不构建 Docker）。
vi.mock('@/server/artifacts', () => ({
  buildApp: async () => {},
  sourceDigest: async () => 'digest-image-input',
  workspace: () => '/nonexistent-image-input-workspace',
  previewUrl: () => 'http://127.0.0.1:3001/preview/test/',
  deployedUrl: () => 'http://127.0.0.1:3001/deploy/test/',
  deployApp: vi.fn(), captureCover: vi.fn(), downloadApp: vi.fn(), hasPreview: async () => true,
  loadBuildState: async () => null,
}));

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');

const request = () => new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' });
const pngOf = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } } }).png().toBuffer();
/** 噪声 PNG：不可压缩，用来构造超过工作区默认 2 MiB 二进制上限的真实图片。 */
const noisePng = async (width = 1200, height = 1200) => sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
const attachmentPart = (row: { id: string; mediaType: string; originalName: string }) => ({ type: 'attachment' as const, attachmentId: row.id, mediaType: row.mediaType, filename: row.originalName });
const payload = (appId: string, requestId: string, parts: unknown[]) => ({ appId, requestId, message: { id: 'client-message', role: 'user', parts } });
const send = (appId: string, requestId: string, parts: unknown[]) => chatResponse(request(), payload(appId, requestId, parts), actor);

function promptFileParts(prompt: LanguageModelV4Prompt): LanguageModelV4FilePart[] {
  const found: LanguageModelV4FilePart[] = [];
  for (const message of prompt) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) if (part.type === 'file') found.push(part);
  }
  return found;
}

function fileByteLength(part: LanguageModelV4FilePart): number {
  if (part.data.type !== 'data') throw new Error('期望内联图片数据');
  const data = part.data.data;
  return typeof data === 'string' ? Buffer.from(data, 'base64').byteLength : data.byteLength;
}

const createdApps: { id: string; type: CodeGenType }[] = [];

let actor: User;
let otherActor: User;

async function insertUser(prefix: string): Promise<User> {
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: `${prefix}_${randomUUID()}`, userPassword: 'unused', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  return publicUser(row);
}

async function insertApp(owner: User, codeGenType: CodeGenType): Promise<string> {
  const id = await nextSnowflakeId();
  await db().insert(apps).values({ id, initPrompt: '图片输入测试', codeGenType, userId: BigInt(owner.id), createTime: now(), updateTime: now() });
  const appId = id.toString();
  createdApps.push({ id: appId, type: codeGenType });
  return appId;
}

async function attach(owner: User, appId: string, originalName: string) {
  return createImageAttachment({ userId: owner.id, appId, originalName, data: await pngOf(32, 24) });
}

async function cleaned(appId: string) {
  await vi.waitFor(async () => {
    expect(await generationFor(appId)).toMatchObject({ status: 'ready' });
    expect(await db().select().from(leases).where(eq(leases.appId, BigInt(appId)))).toHaveLength(0);
  });
}

beforeAll(async () => {
  process.env.MEMORY_ENABLED = 'false';
  actor = await insertUser('ts_image_input');
  otherActor = await insertUser('ts_image_input_other');
});

afterEach(async () => {
  for (const app of createdApps) {
    await db().delete(generationSteps).where(inArray(generationSteps.generationId, db().select({ id: generations.id }).from(generations).where(eq(generations.appId, BigInt(app.id)))));
    for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(app.id)));
    await db().delete(apps).where(eq(apps.id, BigInt(app.id)));
    await rm(workspace({ id: app.id, codeGenType: app.type }), { recursive: true, force: true });
  }
  createdApps.length = 0;
  for (const owner of [actor, otherActor]) {
    const rows = await db().select().from(attachments).where(eq(attachments.ownerUserId, BigInt(owner.id)));
    for (const row of rows) await rm(attachmentObjectPath(row.objectKey), { force: true }).catch(() => {});
    await db().delete(attachments).where(eq(attachments.ownerUserId, BigInt(owner.id)));
    await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + owner.id));
  }
  control.imageInput = true;
  control.prompts.length = 0;
});

afterAll(async () => {
  delete process.env.MEMORY_ENABLED;
  for (const owner of [actor, otherActor]) {
    await db().delete(users).where(eq(users.id, BigInt(owner.id)));
    await rm(join(process.cwd(), 'runtime', 'attachments', owner.id), { recursive: true, force: true });
  }
  await getPool().end();
});

it('带图片的请求把 file part 附到模型消息上，生成正常完成', async () => {
  const appId = await insertApp(actor, 'html');
  const row = await attach(actor, appId, '背景图.png');
  const requestId = randomUUID();
  await (await send(appId, requestId, [{ type: 'text', text: '照着图片做一个页面' }, attachmentPart(row)])).text();
  await cleaned(appId);

  // fixture 模型第一次调用即带图：断言 mediaType 与派生图字节长度。
  const files = promptFileParts(control.prompts[0]);
  expect(files).toHaveLength(1);
  expect(files[0].mediaType).toBe('image/png');
  expect(files[0].filename).toBe('背景图.png');
  const preview = await readAttachmentBytes({ attachmentId: row.id, userId: actor.id, appId });
  expect(fileByteLength(files[0])).toBe(preview.bytes.byteLength);

  // 附件 part 仍留在 ts_message 里供前端回显。
  const stored = await loadMessages(appId);
  expect(stored[0].parts).toContainEqual(expect.objectContaining({ type: 'attachment', attachmentId: row.id }));
  expect(await generationFor(appId)).toMatchObject({ status: 'ready', stopReason: 'completed' });
}, 120000);

it('别名未声明图片输入时以 400 拒绝且不产生生成记录', async () => {
  control.imageInput = false;
  const appId = await insertApp(actor, 'html');
  const row = await attach(actor, appId, '背景图.png');
  await expect(send(appId, randomUUID(), [{ type: 'text', text: '看图' }, attachmentPart(row)])).rejects.toMatchObject({ status: 400, message: expect.stringContaining('图片输入') });
  expect(await generationFor(appId)).toBeNull();
  expect(await loadMessages(appId)).toEqual([]);
  expect(control.prompts).toHaveLength(0);
}, 120000);

it('上传原图复制进工作区并清洗文件名：静态 assets/uploads/，工程 public/uploads/', async () => {
  const staticAppId = await insertApp(actor, 'html');
  const messy = await attach(actor, staticAppId, '参考/背景图.png');
  await (await send(staticAppId, randomUUID(), [{ type: 'text', text: '照做' }, attachmentPart(messy)])).text();
  await cleaned(staticAppId);
  const staticRoot = join(workspace({ id: staticAppId, codeGenType: 'html' }), 'assets', 'uploads');
  const expectedName = `${messy.id.slice(0, 8)}-参考_背景图.png`;
  const copied = await readFile(join(staticRoot, expectedName));
  const original = await readAttachmentBytes({ attachmentId: messy.id, userId: actor.id, appId: staticAppId });
  expect(original.mediaType).toBe('image/png');
  expect(copied.byteLength).toBeGreaterThan(0);
  // 原始名称里的路径分隔符不会在工作区里生成子目录。
  await expect(access(join(staticRoot, messy.id.slice(0, 8) + '-参考', '背景图.png'))).rejects.toThrow();

  const projectAppId = await insertApp(actor, 'vue_project');
  const projectImage = await attach(actor, projectAppId, '配置图.png');
  // 同一用户的第二次生成受 60 秒窗口限制，先清掉限流行。
  await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
  await (await send(projectAppId, randomUUID(), [{ type: 'text', text: '照做' }, attachmentPart(projectImage)])).text();
  await cleaned(projectAppId);
  const projectRoot = join(workspace({ id: projectAppId, codeGenType: 'vue_project' }), 'public', 'uploads');
  const projectName = `${projectImage.id.slice(0, 8)}-配置图.png`;
  expect((await readFile(join(projectRoot, projectName))).byteLength).toBeGreaterThan(0);
}, 120000);

it('超过 2 MiB 的上传原图照样复制进工作区：二进制写入上限已对齐上传上限', async () => {
  const bigAppId = await insertApp(actor, 'html');
  const noisy = await noisePng();
  expect(noisy.byteLength).toBeGreaterThan(2 * 1024 * 1024);
  const row = await createImageAttachment({ userId: actor.id, appId: bigAppId, originalName: '大图.png', data: noisy });
  await (await send(bigAppId, randomUUID(), [{ type: 'text', text: '照做' }, attachmentPart(row)])).text();
  await cleaned(bigAppId);
  const copied = await readFile(join(workspace({ id: bigAppId, codeGenType: 'html' }), 'assets', 'uploads', `${row.id.slice(0, 8)}-大图.png`));
  expect(copied.byteLength).toBe(noisy.byteLength);
}, 120000);

it('第二次生成时历史里不含 file part，只有 [图片：文件名] 占位', async () => {
  const appId = await insertApp(actor, 'html');
  const row = await attach(actor, appId, '背景图.png');
  await (await send(appId, randomUUID(), [{ type: 'text', text: '照着图片做' }, attachmentPart(row)])).text();
  await cleaned(appId);
  // 第一次请求跑两步（写文件 + 回复），两步都在同一轮里带上图片。
  expect(promptFileParts(control.prompts[0])).toHaveLength(1);
  expect(promptFileParts(control.prompts[1])).toHaveLength(1);

  // 同一用户的第二次生成受 60 秒窗口限制，先清掉限流行。
  await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
  await (await send(appId, randomUUID(), [{ type: 'text', text: '再改一下' }])).text();
  await cleaned(appId);

  // 历史轮次不重复发送图片字节：第二次请求的每一步都没有 file part。
  expect(promptFileParts(control.prompts[2])).toHaveLength(0);
  expect(promptFileParts(control.prompts[3])).toHaveLength(0);
  const rows = await db().select().from(histories).where(eq(histories.appId, BigInt(appId)));
  expect(rows.some(entry => entry.message.includes('[图片：背景图.png]'))).toBe(true);
}, 120000);

it('附件不属于本人时 403、不存在时 404，均不开始生成', async () => {
  const appId = await insertApp(actor, 'html');
  const foreignAppId = await insertApp(otherActor, 'html');
  const foreign = await attach(otherActor, foreignAppId, '别人的图.png');

  await expect(send(appId, randomUUID(), [{ type: 'text', text: '看图' }, attachmentPart(foreign)])).rejects.toMatchObject({ status: 403 });
  expect(await generationFor(appId)).toBeNull();

  await expect(send(appId, randomUUID(), [{ type: 'text', text: '看图' }, { type: 'attachment', attachmentId: randomUUID(), mediaType: 'image/png', filename: 'missing.png' }])).rejects.toMatchObject({ status: 404 });
  expect(await generationFor(appId)).toBeNull();
  expect(control.prompts).toHaveLength(0);
}, 120000);

it('客户端消息带 metadata 时也能解析（U3 把待发送附件暂存在 metadata）', async () => {
  const appId = await insertApp(actor, 'html');
  const row = await attach(actor, appId, '背景图.png');
  const body = { appId, requestId: randomUUID(), message: { id: 'client-message', role: 'user', metadata: { attachments: [{ attachmentId: row.id }] }, parts: [{ type: 'text', text: '带元数据发送' }, attachmentPart(row)] } };
  await (await chatResponse(request(), body, actor)).text();
  await cleaned(appId);
  expect(promptFileParts(control.prompts[0])).toHaveLength(1);
}, 120000);
