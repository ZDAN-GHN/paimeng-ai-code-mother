import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelConfigInvalidError } from '@/server/models/errors';
import { decryptModelSecret, encryptModelSecret, modelSecretKeyFile } from '@/server/models/secrets';

const savedKey = process.env.MODEL_SECRET_KEY;
const keyFile = join(process.cwd(), 'runtime', modelSecretKeyFile);
let keyFileExisted = false;

beforeEach(() => {
  keyFileExisted = existsSync(keyFile);
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.MODEL_SECRET_KEY;
  else process.env.MODEL_SECRET_KEY = savedKey;
  if (!keyFileExisted && existsSync(keyFile)) rmSync(keyFile);
});

describe('直接输入密钥的加解密', () => {
  beforeEach(() => {
    process.env.MODEL_SECRET_KEY = 'c'.repeat(64);
  });

  it('加解密往返，密文不含明文且每次 IV 不同', () => {
    const plaintext = 'sk-模型密钥-1234567890';
    const first = encryptModelSecret(plaintext);
    const second = encryptModelSecret(plaintext);

    expect(first).not.toBe(second);
    expect(first.startsWith('v1:')).toBe(true);
    expect(first.split(':')).toHaveLength(4);
    expect(first).not.toContain(plaintext);
    expect(decryptModelSecret(first)).toBe(plaintext);
    expect(decryptModelSecret(second)).toBe(plaintext);
  });

  it('换主密钥后无法解密，错误信息不回显密文', () => {
    process.env.MODEL_SECRET_KEY = 'd'.repeat(64);
    const ciphertext = encryptModelSecret('sk-rotate-me');
    process.env.MODEL_SECRET_KEY = 'e'.repeat(64);

    expect(() => decryptModelSecret(ciphertext)).toThrow(ModelConfigInvalidError);
    try {
      decryptModelSecret(ciphertext);
    } catch (error) {
      expect((error as Error).message).toBe('密钥无法解密，请重新保存密钥');
      expect((error as Error).message).not.toContain(ciphertext);
    }
  });

  it('密文被篡改或格式不识别时都抛配置无效错误', () => {
    const ciphertext = encryptModelSecret('sk-tamper');
    const parts = ciphertext.split(':');
    const tampered = [parts[0], parts[1], parts[2], `${parts[3]?.slice(0, -4)}AAAA`].join(':');

    expect(() => decryptModelSecret(tampered)).toThrow('密钥无法解密');
    expect(() => decryptModelSecret('v2:a:b:c')).toThrow('密钥密文格式无法识别');
    expect(() => decryptModelSecret('nonsense')).toThrow('密钥密文格式无法识别');
    expect(() => decryptModelSecret('v1::')).toThrow('密钥密文格式无法识别');
  });

  it('主密钥支持 64 位十六进制、32 字节 base64 与任意口令', () => {
    for (const material of ['a'.repeat(64), randomBytes(32).toString('base64'), '本地开发口令']) {
      process.env.MODEL_SECRET_KEY = material;
      expect(decryptModelSecret(encryptModelSecret('sk-ok'))).toBe('sk-ok');
    }
  });

  it('未设置主密钥时自动生成密钥文件，且可重复解密', () => {
    delete process.env.MODEL_SECRET_KEY;
    const ciphertext = encryptModelSecret('sk-file-key');

    expect(existsSync(keyFile)).toBe(true);
    expect(decryptModelSecret(ciphertext)).toBe('sk-file-key');
    expect(decryptModelSecret(encryptModelSecret('sk-second'))).toBe('sk-second');
  });
});
