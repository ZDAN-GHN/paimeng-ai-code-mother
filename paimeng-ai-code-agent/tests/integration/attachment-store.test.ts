import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq, like } from 'drizzle-orm';
import sharp from 'sharp';
import { testDatabaseUrl } from '../test-database-url';
import { GET, POST } from '@/app/api/[...path]/route';
import { db, getPool } from '@/server/db';
import { users, apps, sessions, attachments } from '@/server/schema';
import { readAttachmentBytes, attachmentViewUrl } from '@/server/attachment-store';
import { attachmentObjectPath } from '@/server/image-files';
import { imageLimits } from '@/shared/attachments';

loadEnvFile('.env');
process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.AI_MODE = 'fixture';

const origin = 'http://localhost:3000';
const prefix = 'ts_attachment_' + Date.now();
let cookie = '';
let otherCookie = '';
let userId = '';
let appId = '';

type Envelope = { code: number; data: unknown; message: string };

async function call(path: string, data?: unknown, session = cookie): Promise<Response> {
  const method = data === undefined ? 'GET' : 'POST';
  const req = new Request(`${origin}/api/${path}`, { method, headers: { origin, cookie: session, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  return (method === 'GET' ? GET : POST)(req, { params: Promise.resolve({ path: path.split('?')[0].split('/') }) });
}
const json = async (response: Response) => response.json() as Promise<Envelope>;

/** 真实 multipart 请求：同一字段名重复追加，顺序与上传顺序一致。 */
async function upload(session: string, targetAppId: string, images: { bytes: Buffer; name: string; type: string }[]): Promise<Response> {
  const form = new FormData();
  form.append('appId', targetAppId);
  for (const image of images) form.append('images', new File([new Uint8Array(image.bytes)], image.name, { type: image.type }));
  const req = new Request(`${origin}/api/app/attachment/upload`, { method: 'POST', headers: { origin, cookie: session }, body: form });
  return POST(req, { params: Promise.resolve({ path: ['app', 'attachment', 'upload'] }) });
}

async function readAttachment(session: string, targetAppId: string, attachmentId: string): Promise<Response> {
  const req = new Request(`${origin}/api/app/attachment?appId=${targetAppId}&id=${attachmentId}`, { headers: { cookie: session } });
  return GET(req, { params: Promise.resolve({ path: ['app', 'attachment'] }) });
}

const pngOf = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } } }).png().toBuffer();

beforeAll(async () => {
  const credentials = { userAccount: prefix, userPassword: 'password123', checkPassword: 'password123' };
  const registered = await json(await call('user/register', credentials));
  userId = registered.data as string;
  cookie = (await call('user/login', credentials)).headers.get('set-cookie')!.split(';')[0];
  const other = { ...credentials, userAccount: prefix + '_other' };
  await call('user/register', other);
  otherCookie = (await call('user/login', other)).headers.get('set-cookie')!.split(';')[0];
  appId = (await json(await call('app/add', { initPrompt: '附件上传测试应用', codeGenType: 'html' }))).data as string;
});

afterAll(async () => {
  const matching = await db().select({ id: users.id }).from(users).where(like(users.userAccount, prefix + '%'));
  for (const { id } of matching) {
    await db().delete(attachments).where(eq(attachments.ownerUserId, id));
    await db().delete(sessions).where(eq(sessions.userId, id));
    await db().delete(apps).where(eq(apps.userId, id));
    await db().delete(users).where(eq(users.id, id));
    await rm(resolve(process.cwd(), 'runtime', 'attachments', String(id)), { recursive: true, force: true });
  }
  await getPool().end();
});

describe('图片附件存储与上传/读取接口', () => {
  it('真实 multipart 上传两张图：库行字段正确且原图与派生图落盘', async () => {
    const first = await pngOf(40, 30);
    const second = await pngOf(60, 20);
    const response = await upload(cookie, appId, [
      { bytes: first, name: '第一张.png', type: 'image/png' },
      { bytes: second, name: 'second.png', type: 'image/png' },
    ]);
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.code).toBe(0);
    const infos = (payload.data as { attachments: { id: string; originalName: string; mediaType: string; bytes: number; width: number; height: number }[] }).attachments;
    expect(infos).toHaveLength(2);
    expect(infos.map(info => info.originalName)).toEqual(['第一张.png', 'second.png']);
    expect(infos[0]).toMatchObject({ mediaType: 'image/png', width: 40, height: 30 });
    expect(infos[1]).toMatchObject({ mediaType: 'image/png', width: 60, height: 20 });
    expect(infos[0]).not.toHaveProperty('objectKey');
    expect(infos[0].id).toMatch(/^[a-f0-9-]{36}$/);

    const rows = await db().select().from(attachments).where(eq(attachments.appId, BigInt(appId)));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const info = infos.find(candidate => candidate.id === row.id)!;
      expect(String(row.ownerUserId)).toBe(userId);
      expect(row.appId).toBe(BigInt(appId));
      expect(row.mediaType).toBe('image/png');
      expect(row.bytes).toBe(info.bytes);
      expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
      // 落盘：规范化原图 + 最长边 ≤ maxEdge 的派生图。
      const objectFile = await stat(attachmentObjectPath(row.objectKey));
      expect(objectFile.size).toBe(row.bytes);
      const previewFile = await stat(attachmentObjectPath(row.previewKey));
      expect(previewFile.size).toBeGreaterThan(0);
      const preview = await sharp(await readFile(attachmentObjectPath(row.previewKey))).metadata();
      expect(preview.width).toBeLessThanOrEqual(imageLimits.maxEdge);
      expect(preview.height).toBeLessThanOrEqual(imageLimits.maxEdge);
    }
  });

  it('读取接口返回真实字节与 content-type，派生图供模型使用', async () => {
    const [row] = await db().select().from(attachments).where(eq(attachments.appId, BigInt(appId))).limit(1);
    const response = await readAttachment(cookie, appId, row.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('private, max-age=300');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const expected = await readFile(attachmentObjectPath(row.objectKey));
    expect(response.headers.get('content-length')).toBe(String(expected.length));
    expect(Buffer.from(await response.arrayBuffer()).equals(expected)).toBe(true);

    const model = await readAttachmentBytes({ attachmentId: row.id, userId, appId });
    expect(model.mediaType).toBe('image/png');
    expect(model.filename).toBe(row.originalName);
    expect(model.bytes.equals(await readFile(attachmentObjectPath(row.previewKey)))).toBe(true);
    const metadata = await sharp(model.bytes).metadata();
    expect(metadata.width).toBeLessThanOrEqual(imageLimits.maxEdge);
    expect(metadata.height).toBeLessThanOrEqual(imageLimits.maxEdge);
    expect(attachmentViewUrl(appId, row.id)).toBe(`/api/app/attachment?appId=${appId}&id=${row.id}`);
  });

  it('越权读取：非本人 403、附件不存在 404', async () => {
    const [row] = await db().select().from(attachments).where(eq(attachments.appId, BigInt(appId))).limit(1);
    expect((await readAttachment(otherCookie, appId, row.id)).status).toBe(403);
    expect((await readAttachment(cookie, appId, randomUUID())).status).toBe(404);
    await expect(readAttachmentBytes({ attachmentId: row.id, userId: '999999', appId })).rejects.toMatchObject({ status: 403 });
  });

  it('数量、字节、类型与像素校验', async () => {
    const tiny = await pngOf(4, 4);
    const five = Array.from({ length: 5 }, (_, index) => ({ bytes: tiny, name: `img-${index}.png`, type: 'image/png' }));
    expect((await upload(cookie, appId, five)).status).toBe(400);

    const oversize = Buffer.alloc(imageLimits.maxBytes + 1);
    expect((await upload(cookie, appId, [{ bytes: oversize, name: 'big.png', type: 'image/png' }])).status).toBe(413);

    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    expect((await upload(cookie, appId, [{ bytes: gif, name: 'anim.gif', type: 'image/gif' }])).status).toBe(400);
    expect((await upload(cookie, appId, [{ bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), name: 'vec.svg', type: 'image/svg+xml' }])).status).toBe(400);
    // 声明成 PNG 但字节是 GIF：交给解码器按字节判定后仍然拒绝。
    expect((await upload(cookie, appId, [{ bytes: gif, name: 'fake.png', type: 'image/png' }])).status).toBe(400);

    const huge = await pngOf(6000, 4000);
    expect((await upload(cookie, appId, [{ bytes: huge, name: 'huge.png', type: 'image/png' }])).status).toBe(400);

    // 校验失败的请求不应留下库行（数量/字节/类型都在落库前拦截）。
    const kept = await db().select().from(attachments).where(eq(attachments.ownerUserId, BigInt(userId)));
    expect(kept).toHaveLength(2);
  });

  it('缺少应用标识或应用不属于本人时拒绝', async () => {
    const tiny = await pngOf(4, 4);
    const form = new FormData();
    form.append('images', new File([new Uint8Array(tiny)], 'no-app.png', { type: 'image/png' }));
    const noApp = await POST(new Request(`${origin}/api/app/attachment/upload`, { method: 'POST', headers: { origin, cookie }, body: form }), { params: Promise.resolve({ path: ['app', 'attachment', 'upload'] }) });
    expect(noApp.status).toBe(400);
    expect((await upload(otherCookie, appId, [{ bytes: tiny, name: 'foreign.png', type: 'image/png' }])).status).toBe(403);
  });

  it('纠正 EXIF 方向并去掉私有元数据', async () => {
    const jpeg = await sharp({ create: { width: 100, height: 40, channels: 3, background: { r: 5, g: 6, b: 7 } } }).jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'secret' } } }).toBuffer();
    const response = await upload(cookie, appId, [{ bytes: jpeg, name: 'rotated.jpg', type: 'image/jpeg' }]);
    expect(response.status).toBe(200);
    const infos = ((await json(response)).data as { attachments: { id: string; width: number; height: number }[] }).attachments;
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ width: 40, height: 100 });
    const [row] = await db().select().from(attachments).where(eq(attachments.id, infos[0].id));
    const stored = await sharp(await readFile(attachmentObjectPath(row.objectKey))).metadata();
    expect(stored.width).toBe(40);
    expect(stored.height).toBe(100);
    expect(stored.orientation).toBeUndefined();
    expect(stored.exif).toBeUndefined();
  });
});
