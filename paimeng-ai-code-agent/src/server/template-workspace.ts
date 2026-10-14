import 'server-only';
import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TEMPLATE_MARKER, readTemplateFile, readTemplateIdentity, resolveTemplate, templateFiles } from './templates';
import { ensureRuntime, ensureSafeDirectory, workspace, writeProjectFile, type WorkspaceApp } from './workspace';
import type { TemplateIdentity } from '@/shared/templates';

export async function appTemplate(app: WorkspaceApp) {
  const template = await readTemplateIdentity(workspace(app));
  if (template && template.codeGenType !== app.codeGenType) throw new Error('模板与应用类型不匹配');
  return template;
}

export async function initializeTemplate(app: WorkspaceApp, identity: TemplateIdentity) {
  const template = resolveTemplate(identity.id, identity.version);
  if (template.codeGenType !== app.codeGenType) throw new Error('模板与应用类型不匹配');
  const root = await ensureRuntime();
  await ensureSafeDirectory(join(root, 'code_output'));
  const destination = workspace(app);
  try { await mkdir(destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await appTemplate(app);
    if (existing?.id === template.id && existing.version === template.version) return false;
    throw new Error('已有工程不能用模板覆盖');
  }
  try {
    for (const path of templateFiles(template)) await writeProjectFile(app, path, await readTemplateFile(template, path));
    const handle = await open(join(destination, TEMPLATE_MARKER), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ id: template.id, version: template.version })); }
    finally { await handle.close(); }
    return true;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
