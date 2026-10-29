import 'server-only';
import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TEMPLATE_MARKER, readTemplateFile, readTemplateIdentity, resolveTemplate, templateFiles } from './templates';
import { ensureProjectRoot, projectRootPath, writeProjectFile, type ProjectTarget } from './workspace';
import type { TemplateIdentity } from '@/shared/templates';

export async function appTemplate(target: ProjectTarget) {
  const app = 'app' in target ? target.app : target;
  const template = await readTemplateIdentity(await ensureProjectRoot(target));
  if (template && template.codeGenType !== app.codeGenType) throw new Error('模板与应用类型不匹配');
  return template;
}

export async function initializeTemplate(target: ProjectTarget, identity: TemplateIdentity) {
  const app = 'app' in target ? target.app : target;
  const template = resolveTemplate(identity.id, identity.version);
  if (template.codeGenType !== app.codeGenType) throw new Error('模板与应用类型不匹配');
  const destination = projectRootPath(target);
  try { await mkdir(destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await appTemplate(target);
    if (existing?.id === template.id && existing.version === template.version) return false;
    throw new Error('已有工程不能用模板覆盖');
  }
  try {
    for (const path of templateFiles(template)) await writeProjectFile(target, path, await readTemplateFile(template, path));
    const handle = await open(join(destination, TEMPLATE_MARKER), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ id: template.id, version: template.version })); }
    finally { await handle.close(); }
    return true;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
