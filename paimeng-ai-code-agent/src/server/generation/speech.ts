import 'server-only';
import { z } from 'zod';
import { isAllowedModelApiKeyEnv, type ModelProvider } from '@/shared/model-config';
import { getConfig } from '../infra/config';
import { BusinessError } from '../infra/http';
import { isAliasNotConfigured } from './model';
import type { AliasModel } from '../models/adapters';
import { modelRegistry } from '../models/registry';
import { decryptModelSecret } from '../models/secrets';
import { readConfigSnapshot } from '../models/store';

/**
 * 语音输入的服务端：录音由浏览器（MediaRecorder）产生，转写走「可配置的 OpenAI 兼容
 * `/audio/transcriptions`」别名。项目现有 provider 都没有音频接口，所以 `speech.transcribe`
 * 是可选别名，不进 requiredModelAliases：没配置时接口明确报「未配置语音转写模型」，客户端
 * 据此禁用麦克风按钮，而不是假装可用。
 */
export const speechTranscribeAlias = 'speech.transcribe';
/** 音频上限与转写超时；服务端是权威校验，客户端只做提前提示。 */
export const speechLimits = { maxBytes: 10 * 1024 * 1024, timeoutMs: 60_000 } as const;
/** multipart 里的音频文件字段名。 */
const speechUploadFieldName = 'audio';
/** 请求体读取上限：音频上限加 64 KiB 表单与头部余量；超过直接 413，不进入解析。 */
const speechUploadBodyLimitBytes = speechLimits.maxBytes + 64 * 1024;
/** 只接受浏览器 MediaRecorder 实际会产出的容器。 */
const speechMediaTypes = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'] as const;
const speechMediaTypeHint = '只支持 webm、ogg、mp4（m4a）、mpeg（mp3）、wav 音频';

const mediaTypeByExtension: Readonly<Record<string, string>> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  wav: 'audio/wav',
};

/** 声明类型优先（去掉 `;codecs=…` 参数），缺失时按扩展名兜底；白名单外或无法判定返回 null。 */
function speechMediaType(declared: string | null, filename: string | null): string | null {
  const normalized = declared?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalized) return (speechMediaTypes as readonly string[]).includes(normalized) ? normalized : null;
  const extension = filename?.split('.').pop()?.trim().toLowerCase() ?? '';
  return mediaTypeByExtension[extension] ?? null;
}

const cr = 0x0d;
const lf = 0x0a;
const dash = 0x2d;

const badRequest = (message: string) => new BusinessError(400, 40000, message);
const invalidMultipart = () => badRequest('multipart/form-data 解析失败');

/** 转写通道绕开了 http.ts 的 JSON 体积上限（100000 字节），所以自行做来源校验。 */
function guardSpeechRequest(req: Request): void {
  const config = getConfig();
  if (new URL(req.url).origin !== config.appOrigin) throw new BusinessError(403, 40300, '管理接口来源不合法');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.get('origin') !== config.appOrigin) throw new BusinessError(403, 40300, '写请求必须来自管理界面');
}

function multipartBoundary(req: Request): string {
  const header = req.headers.get('content-type') ?? '';
  const [type, ...params] = header.split(';');
  if (type.trim().toLowerCase() !== 'multipart/form-data') throw new BusinessError(415, 40000, '转写接口只接受 multipart/form-data');
  for (const param of params) {
    const separator = param.indexOf('=');
    if (separator < 0) continue;
    if (param.slice(0, separator).trim().toLowerCase() !== 'boundary') continue;
    const value = param.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1');
    if (value) return value;
  }
  throw badRequest('multipart/form-data 缺少 boundary');
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

/** 只在参数边界上匹配，避免 `filename` 误命中 `name`。 */
function dispositionParameter(disposition: string | undefined, key: 'name' | 'filename'): string | null {
  if (!disposition) return null;
  const quoted = new RegExp(`(?:^|;\\s*)${key}="([^"]*)"`, 'i').exec(disposition);
  if (quoted) return quoted[1];
  const bare = new RegExp(`(?:^|;\\s*)${key}=([^;\\s]+)`, 'i').exec(disposition);
  return bare ? bare[1] : null;
}

/**
 * 取 multipart 里带文件名的 `audio` 字段：按字节扫描分隔符，不对二进制内容做字符串转换。
 * 图片通道（image-upload.ts）的解析器是私有的、只认 `images` 字段且要解析文本字段，所以这里
 * 按同一套做法写一个更小的版本，只找音频文件。
 */
function readAudioPart(body: Buffer, boundary: string): { contentType: string | null; filename: string; data: Buffer } {
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
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
    const headers = new Map<string, string>();
    for (const line of part.subarray(0, headerEnd).toString('utf8').split('\r\n')) {
      const separator = line.indexOf(':');
      if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    const disposition = headers.get('content-disposition');
    const filename = dispositionParameter(disposition, 'filename');
    if (dispositionParameter(disposition, 'name') === speechUploadFieldName && filename) {
      return { contentType: headers.get('content-type') ?? null, filename, data: Buffer.from(part.subarray(headerEnd + 4)) };
    }
    cursor = next + delimiter.length;
  }
  throw badRequest('缺少录音文件');
}

/** 别名未配置或未启用时 registry 抛固定文案的 503；只有这一种情况算「没配」，其它错误照常上抛。 */
async function transcribeBinding(): Promise<AliasModel | null> {
  try {
    return await modelRegistry().resolveBinding(speechTranscribeAlias);
  } catch (error) {
    if (isAliasNotConfigured(error, speechTranscribeAlias)) return null;
    throw error;
  }
}

/**
 * 提供商的密钥解析，规则与 models/adapters.ts 的 `resolveModelApiKey` 一致：
 * `env` 必须命中部署允许名单且环境变量非空，`inline` 解密已保存的密文。
 * 取不到就按别名不可用处理，绝不把失败原因里的密文或环境变量值回显出去。
 */
function providerApiKey(provider: ModelProvider): string | null {
  if (provider.apiKeySource === 'env') {
    if (!isAllowedModelApiKeyEnv(provider.apiKeyEnv, getConfig().modelApiKeyEnvAllowlist)) return null;
    return process.env[provider.apiKeyEnv] ?? null;
  }
  try {
    return decryptModelSecret(provider.apiKeyCiphertext);
  } catch {
    return null;
  }
}

/** 转写调用要的三件东西：提供商地址、上游模型名、解密后的密钥。密钥只活在这个局部变量里。 */
type TranscriptionTarget = { baseUrl: string; modelName: string; apiKey: string };

/**
 * 别名存在/启用由 registry 判定（可选别名，不进 requiredModelAliases）；地址与密钥从同一份配置快照里取。
 * 别名缺失、提供商被删/禁用、密钥取不到都返回 null，由调用方决定是禁用按钮还是报 409。
 */
async function transcribeTarget(): Promise<TranscriptionTarget | null> {
  const binding = await transcribeBinding();
  if (!binding) return null;
  const snapshot = await readConfigSnapshot();
  const provider = snapshot.providers.find(candidate => candidate.id === binding.providerId && candidate.enabled);
  if (!provider) return null;
  const apiKey = providerApiKey(provider);
  if (!apiKey) return null;
  return { baseUrl: provider.baseUrl, modelName: binding.modelName, apiKey };
}

/** 别名已配置且可用时为 true；读取失败按不可用处理（禁用麦克风并提示，不假装可用）。 */
export async function transcribeEnabled(): Promise<boolean> {
  try {
    return (await transcribeTarget()) !== null;
  } catch {
    return false;
  }
}

/** OpenAI 兼容的转写端点：baseUrl 通常带 /v1，允许带尾斜杠。 */
function transcriptionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
}

const transcriptSchema = z.object({ text: z.string() });

/**
 * 调用别名的 /audio/transcriptions。密钥只出现在请求头，错误文案里绝不回显它；
 * 上游状态码分支与 models/probe.ts 的探测保持一致，给出可操作的提示。
 */
async function requestTranscription(target: TranscriptionTarget, audio: { contentType: string; filename: string; data: Buffer }): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio.data)], { type: audio.contentType }), audio.filename);
  form.append('model', target.modelName);
  let response: Response;
  try {
    response = await fetch(transcriptionUrl(target.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${target.apiKey}` },
      body: form,
      cache: 'no-store',
      signal: AbortSignal.timeout(speechLimits.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new BusinessError(502, 50200, timedOut
      ? `语音转写超过 ${speechLimits.timeoutMs / 1000} 秒没有响应`
      : '无法连接语音转写服务，请检查网络与提供商地址');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new BusinessError(502, 50200, `语音转写服务拒绝了密钥（${response.status}），请检查别名 ${speechTranscribeAlias} 的提供商密钥`);
    if (response.status === 404) throw new BusinessError(502, 50200, `语音转写服务没有 /audio/transcriptions 接口（404），请检查别名 ${speechTranscribeAlias} 的提供商地址`);
    throw new BusinessError(502, 50200, `语音转写服务返回 ${response.status}`);
  }
  const payload = transcriptSchema.safeParse(await response.json().catch(() => null));
  if (!payload.success) throw new BusinessError(502, 50200, '语音转写服务没有返回可识别的文本');
  return payload.data.text;
}

/** 转写入口：校验来源、体积与格式后把音频转发给别名的 /audio/transcriptions。 */
export async function transcribeSpeech(req: Request): Promise<string> {
  guardSpeechRequest(req);
  const boundary = multipartBoundary(req);
  const raw = await readRequestBytes(req, speechUploadBodyLimitBytes);
  const audio = readAudioPart(raw, boundary);
  const mediaType = speechMediaType(audio.contentType, audio.filename);
  if (!mediaType) throw badRequest(`不支持的音频格式：${speechMediaTypeHint}`);
  if (audio.data.length > speechLimits.maxBytes) throw new BusinessError(413, 40000, `录音不能超过 ${speechLimits.maxBytes / (1024 * 1024)} MiB`);
  const target = await transcribeTarget();
  if (!target) throw new BusinessError(409, 40900, `未配置语音转写模型：请在模型管理里新增别名 ${speechTranscribeAlias}（OpenAI 兼容的 /audio/transcriptions）`);
  return requestTranscription(target, { contentType: mediaType, filename: audio.filename, data: audio.data });
}
