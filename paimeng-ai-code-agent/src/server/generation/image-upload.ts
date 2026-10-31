import 'server-only';
import { imageLimits, isImageMediaType, type AttachmentInfo } from '@/shared/attachments';
import { idSchema } from '@/shared/contracts';
import { createImageAttachment, type AttachmentRow } from './attachment-store';
import { getConfig } from '../infra/config';
import { BusinessError } from '../infra/http';

/** multipart 表单里的图片文件字段名；同一字段可重复出现，返回顺序与追加顺序一致。 */
export const imageUploadFieldName = 'images';
/** 目标应用标识字段（文本字段），上传接口用它做归属校验。 */
export const imageUploadAppIdField = 'appId';
/** 单请求缓冲上限：单条消息总字节上限再加 1 MiB 表单/头部余量；超限 413，不进入解析。 */
export const imageUploadBodyLimitBytes = imageLimits.maxMessageBytes + 1024 * 1024;

const cr = 0x0d;
const lf = 0x0a;
const dash = 0x2d;

type MultipartField = {
  readonly name: string;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly data: Buffer;
};

function badRequest(message: string): BusinessError {
  return new BusinessError(400, 40000, message);
}

/** 上传通道绕开了 http.ts 的 JSON 体积上限（100000 字节），所以自行做来源校验。 */
export function guardImageUploadRequest(req: Request): void {
  const config = getConfig();
  if (new URL(req.url).origin !== config.appOrigin) throw new BusinessError(403, 40300, '管理接口来源不合法');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.get('origin') !== config.appOrigin) throw new BusinessError(403, 40300, '写请求必须来自管理界面');
}

function multipartBoundary(req: Request): string {
  const header = req.headers.get('content-type') ?? '';
  const [type, ...params] = header.split(';');
  if (type.trim().toLowerCase() !== 'multipart/form-data') throw new BusinessError(415, 40000, '上传接口只接受 multipart/form-data');
  for (const param of params) {
    const separator = param.indexOf('=');
    if (separator < 0) continue;
    if (param.slice(0, separator).trim().toLowerCase() !== 'boundary') continue;
    const value = param.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1');
    if (value) return value;
  }
  throw badRequest('multipart/form-data 缺少 boundary');
}

const invalidMultipart = () => badRequest('multipart/form-data 解析失败');

function parsePartHeaders(raw: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of raw.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

/** 只解析 `name` / `filename` 两个参数；参数名必须落在参数边界上，避免 `filename` 误匹配 `name`。 */
function dispositionParameter(disposition: string | undefined, key: 'name' | 'filename'): string | null {
  if (!disposition) return null;
  const quoted = new RegExp(`(?:^|;\\s*)${key}="([^"]*)"`, 'i').exec(disposition);
  if (quoted) return quoted[1];
  const bare = new RegExp(`(?:^|;\\s*)${key}=([^;\\s]+)`, 'i').exec(disposition);
  return bare ? bare[1] : null;
}

/**
 * 解析 multipart/form-data 请求体。按字节扫描分隔符，不对二进制内容做字符串转换；
 * 只在解析出边界或字段时返回，结构不完整一律按 400 处理。
 */
function parseMultipartForm(body: Buffer, boundary: string): MultipartField[] {
  if (!boundary) throw invalidMultipart();
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const fields: MultipartField[] = [];
  let cursor = body.indexOf(delimiter);
  if (cursor < 0) throw invalidMultipart();
  cursor += delimiter.length;
  for (;;) {
    if (body[cursor] === dash && body[cursor + 1] === dash) break;
    if (body[cursor] === cr && body[cursor + 1] === lf) cursor += 2;
    else throw invalidMultipart();
    const next = body.indexOf(delimiter, cursor);
    if (next < 0) throw invalidMultipart();
    let end = next;
    if (body[end - 2] === cr && body[end - 1] === lf) end -= 2;
    const part = body.subarray(cursor, end);
    const headerEnd = part.indexOf('\r\n\r\n', 0, 'latin1');
    if (headerEnd < 0) throw invalidMultipart();
    /* 头块按 UTF-8 解码：浏览器在 `filename="…"` 里直接放 UTF-8 字节，按 latin1 会把中文名解成乱码。 */
    const headers = parsePartHeaders(part.subarray(0, headerEnd).toString('utf8'));
    const name = dispositionParameter(headers.get('content-disposition'), 'name');
    if (!name) throw invalidMultipart();
    const filename = dispositionParameter(headers.get('content-disposition'), 'filename');
    fields.push({ name, filename: filename ? filename : null, contentType: headers.get('content-type') ?? null, data: Buffer.from(part.subarray(headerEnd + 4)) });
    cursor = next + delimiter.length;
  }
  return fields;
}

/** 边读边计量，超过 maxBytes 立刻取消读取流，不信 Content-Length。 */
async function readRequestBytes(req: Request, maxBytes: number): Promise<Buffer> {
  if (!req.body) throw badRequest('缺少请求体');
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BusinessError(413, 40000, '上传内容超过大小限制');
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function textField(fields: readonly MultipartField[], name: string): string | null {
  return fields.find(field => field.name === name && field.filename === null)?.data.toString('utf8') ?? null;
}

/** 数量校验：至少一张、不超过 imageLimits.maxImages；合规返回 null。 */
export function imageCountIssue(count: number): string | null {
  if (count <= 0) return '请至少上传一张图片';
  if (count > imageLimits.maxImages) return `一条消息最多 ${imageLimits.maxImages} 张图片`;
  return null;
}

/**
 * 声明类型校验：空声明交给解码器按字节判定；声明为非图片直接拒绝，
 * 声明为其它图片格式（SVG、GIF、HEIC 等）也提前拒绝并给出可操作的提示。
 */
export function imageMediaTypeIssue(declared: string | null): string | null {
  const normalized = declared?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!normalized) return null;
  if (['image/jpeg', 'image/png', 'image/webp'].includes(normalized)) return null;
  if (normalized.startsWith('image/')) return '只支持 JPEG、PNG、WebP 图片';
  return '只能上传图片文件';
}

/** 大小校验：单图不超过 5 MiB、同一消息图片总量不超过 12 MiB；合规返回 null。 */
export function imageBytesIssue(fileBytes: readonly number[]): string | null {
  if (fileBytes.some(bytes => bytes > imageLimits.maxBytes)) return `单张图片不能超过 ${imageLimits.maxBytes / (1024 * 1024)} MiB`;
  const total = fileBytes.reduce((sum, bytes) => sum + bytes, 0);
  if (total > imageLimits.maxMessageBytes) return `本条消息图片总大小不能超过 ${imageLimits.maxMessageBytes / (1024 * 1024)} MiB`;
  return null;
}

/** 附件行 -> 客户端可见信息；objectKey/previewKey 不对外暴露。 */
function toAttachmentInfo(row: AttachmentRow): AttachmentInfo {
  if (!isImageMediaType(row.mediaType)) throw new Error('附件图片类型不受支持');
  return { id: row.id, originalName: row.originalName, mediaType: row.mediaType, bytes: row.bytes, width: row.width, height: row.height };
}

/**
 * multipart 上传入口：校验来源、体积、数量、类型与字节，逐张交给 U1 附件存储落库。
 * 返回按上传顺序排列的附件信息；中途失败不返回部分结果（前面已落库的图片按未引用附件留存）。
 */
export async function uploadImages(input: { userId: string; req: Request; signal?: AbortSignal }): Promise<AttachmentInfo[]> {
  guardImageUploadRequest(input.req);
  const boundary = multipartBoundary(input.req);
  const raw = await readRequestBytes(input.req, imageUploadBodyLimitBytes);
  const fields = parseMultipartForm(raw, boundary);
  const appIdField = textField(fields, imageUploadAppIdField);
  if (!appIdField) throw badRequest('缺少应用标识');
  const appId = idSchema.parse(appIdField);
  const files = fields.filter(field => field.name === imageUploadFieldName && field.filename !== null);
  const countIssue = imageCountIssue(files.length);
  if (countIssue) throw badRequest(countIssue);
  for (const file of files) {
    const mediaTypeIssue = imageMediaTypeIssue(file.contentType);
    if (mediaTypeIssue) throw badRequest(mediaTypeIssue);
  }
  const bytesIssue = imageBytesIssue(files.map(file => file.data.length));
  if (bytesIssue) throw new BusinessError(413, 40000, bytesIssue);

  const uploaded: AttachmentInfo[] = [];
  for (const file of files) {
    input.signal?.throwIfAborted();
    const row = await createImageAttachment({ userId: input.userId, appId, originalName: file.filename ?? 'image', data: file.data, signal: input.signal });
    uploaded.push(toAttachmentInfo(row));
  }
  return uploaded;
}
