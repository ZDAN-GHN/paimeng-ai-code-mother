import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig } from '../infra/config';
import { ModelConfigInvalidError } from './errors';

/** 直接输入密钥的加密版本；将来更换算法时递增，旧密文仍可解密。 */
const secretVersion = 'v1';
const secretAlgorithm = 'aes-256-gcm';
const secretKeyLength = 32;
const secretIvLength = 12;
const scryptSalt = 'paimeng-model-secret';
const derivedKeys = new Map<string, Buffer>();

/** 密钥文件兜底路径；未设置 MODEL_SECRET_KEY 时自动生成并保存在这里。 */
export const modelSecretKeyFile = 'model-secret.key';

/** 解析主密钥：64 位十六进制、32 字节 base64，或任意长度口令（scrypt 派生，结果进程内缓存）。 */
function decodeMasterKey(material: string): Buffer {
  const trimmed = material.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  if (/^[A-Za-z0-9+/]{43}=?$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === secretKeyLength) return decoded;
  }
  const cached = derivedKeys.get(trimmed);
  if (cached) return cached;
  const derived = scryptSync(trimmed, scryptSalt, secretKeyLength);
  derivedKeys.set(trimmed, derived);
  return derived;
}

/** 读取或创建本地主密钥文件；并发创建时以先写成功的内容为准（wx 独占写）。 */
function readOrCreateKeyFile(file: string): string {
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const created = randomBytes(secretKeyLength).toString('base64');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, `${created}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readFileSync(file, 'utf8').trim();
    if (!existing) throw new ModelConfigInvalidError('模型密钥文件为空，请删除后重新保存密钥');
    return existing;
  }
  return created;
}

/** 主密钥：优先环境变量 MODEL_SECRET_KEY，未设置时用 runtime/model-secret.key。 */
function masterKey(): Buffer {
  const config = getConfig();
  if (config.modelSecretKey) return decodeMasterKey(config.modelSecretKey);
  return decodeMasterKey(readOrCreateKeyFile(join(config.runtimeRoot, modelSecretKeyFile)));
}

/** 加密直接输入的密钥，返回 `v1:<iv>:<tag>:<ciphertext>`（base64url）。 */
export function encryptModelSecret(plaintext: string): string {
  const iv = randomBytes(secretIvLength);
  const cipher = createCipheriv(secretAlgorithm, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [secretVersion, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
}

/** 解密直接输入的密钥；格式不可识别、认证失败或主密钥变了都归一化为配置无效错误，且不回显密文。 */
export function decryptModelSecret(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== secretVersion || !parts[1] || !parts[2] || !parts[3]) {
    throw new ModelConfigInvalidError('密钥密文格式无法识别，请重新保存密钥');
  }
  try {
    const decipher = createDecipheriv(secretAlgorithm, masterKey(), Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof ModelConfigInvalidError) throw error;
    throw new ModelConfigInvalidError('密钥无法解密，请重新保存密钥');
  }
}
