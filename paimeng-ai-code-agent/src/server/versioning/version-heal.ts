import 'server-only';
import { insertVersionRow, listVersionShas } from './version-ledger';
import { listVersionPins } from './version-store';
import type { WorkspaceApp } from '../workspace/workspace';

/**
 * 版本台账的自愈：唯一同时看得到 Git 钉子与表行的地方。
 *
 * 「有钉无行」只会来自收尾进程在提交之后、插行之前被强杀。
 * 补行的内容全部能从 Git 读回来（shas 来自钉子，标题来自那一轮的提交信息），
 * 所以这是纯幂等修复，不需要人工判断，也不该放在「只碰表」的台账模块里。
 */
export async function healVersionRows(app: WorkspaceApp): Promise<number> {
  const pins = await listVersionPins(app);
  if (pins.length === 0) return 0;
  const known = new Set(await listVersionShas(app.id));
  const missing = pins.filter(pin => !known.has(pin.sha));
  let healed = 0;
  for (const pin of missing) {
    // 并发的两次自愈会撞主键，第二次插入返回 false，不计入补行数。
    if (await insertVersionRow({ appId: app.id, commitSha: pin.sha, title: pin.subject })) healed += 1;
  }
  return healed;
}
