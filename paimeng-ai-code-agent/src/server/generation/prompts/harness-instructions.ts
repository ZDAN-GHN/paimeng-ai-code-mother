import type { AppInfo } from '@/shared/contracts';
import { getConfig } from '../../infra/config';
import { templateEntry } from '../../templates/templates';
import { webAccessInstructions } from '../tools/web/instructions';
import { generationInstructions } from './generation-instructions';

/**
 * 常驻指令：应用、模板入口、联网能力与本轮是否带图都在这里合成一轮的 instructions。
 * 提示词本身按应用类型生成（`generation-instructions`），这里只决定拼进哪几段。
 */
export function harnessInstructions(app: AppInfo, hasImages: boolean): string {
  const webAccess = getConfig().webAccess;
  return generationInstructions({
    app,
    template: app.template,
    entry: app.template ? templateEntry(app.template) : null,
    webInstruction: webAccess.enabled ? ` ${webAccessInstructions({ images: webAccess.images, strictLicense: webAccess.strictLicense })}` : '',
    hasImages,
  });
}
