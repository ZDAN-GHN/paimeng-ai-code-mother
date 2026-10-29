import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const now = new Date();
const day = [
  String(now.getFullYear()).slice(-2),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
].join('-');

const root = join(fileURLToPath(new URL('../../../../', import.meta.url)), '.agents/skills/verify-paimeng/evidences', day);

/** Return a dated evidence directory under verify-paimeng/evidences, creating it. */
export function evidenceDir(...parts: string[]): string {
  const dir = join(root, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Return a dated evidence file path under verify-paimeng/evidences, creating its parent directory. */
export function evidencePath(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
