import { createInterface } from 'node:readline';
import { getPool } from '@/server/infra/db';
import { modelRegistry } from '@/server/models/registry';
import { readConfigSnapshot, upsertAlias } from '@/server/models/store';
import type { ModelAliasInput } from '@/shared/model-config';

type Command =
  | { command: 'resolve'; alias: string }
  | { command: 'setCodegenModel'; modelName: string; applyImmediately: boolean }
  | { command: 'close' };

async function handle(message: Command): Promise<Record<string, unknown>> {
  switch (message.command) {
    case 'resolve': {
      const binding = await modelRegistry().resolveBinding(message.alias);
      const status = modelRegistry().status();
      return {
        ok: true,
        modelName: binding.modelName,
        providerId: binding.providerId,
        revision: status.revision,
        refreshEpoch: status.refreshEpoch,
        degraded: status.degraded,
      };
    }
    case 'setCodegenModel': {
      const snapshot = await readConfigSnapshot();
      const alias = snapshot.aliases.find(candidate => candidate.alias === 'codegen.default');
      if (!alias) throw new Error('缺少 codegen.default');
      const input: ModelAliasInput = {
        alias: alias.alias,
        providerId: alias.providerId,
        modelName: message.modelName,
        capabilities: alias.capabilities,
        settings: alias.settings,
        enabled: alias.enabled,
      };
      const version = await upsertAlias(input, { expectedRevision: snapshot.revision, applyImmediately: message.applyImmediately });
      return { ok: true, revision: version.revision, refreshEpoch: version.refreshEpoch };
    }
    case 'close':
      await getPool().end();
      return { ok: true };
  }
}

const reader = createInterface({ input: process.stdin });
reader.on('line', async line => {
  let parsed: Command;
  try {
    parsed = JSON.parse(line) as Command;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await handle(parsed))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  }
});
