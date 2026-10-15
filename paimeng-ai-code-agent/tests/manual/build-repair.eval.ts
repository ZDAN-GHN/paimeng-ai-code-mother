/**
 * 手工评估：真实模型 + 真实容器构建下的「构建失败 → 模型修复」闭环。
 * 见 docs/plans/agent-design-review.md §8.11。默认不进 `npm run test`，跑法见 package.json 的 `eval:repair`。
 *
 * 它不复制 agent 逻辑，只在边界上包一层：
 *  - 包 buildApp：记录每次构建的阶段、耗时、失败诊断，以及构建前后的源码快照；
 *  - 包 taskModelsFor 返回的模型：记录每一步真正发给模型的输入；
 *  - 包 generation-store 的状态转移与逐步落库：得到完整时间线。
 *
 * 场景（EVAL_SCENARIO）：
 *  - seeded（默认）：拿一份真实生成出来的 vue 工程，在**模型开始工作之前**往一个它不会改的视图里
 *    注入一个「可空值在模板里直接解引用」的类型错误（与历史上真实发生过的
 *    `'__VLS_ctx.user' is possibly 'null'` 同类）。基线构建会先证明这份工程本来能构建通过，
 *    于是第 1 轮构建的失败只可能来自这个注入，修复轮必须仅凭诊断去改一个它没写过的文件。
 *  - natural：空模板工程 + 一个真实需求，看自然生成会不会触发修复轮。
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { loadEnvFile } from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import { chatResponse } from '@/server/agent';
import { db, getPool, now } from '@/server/db';
import { nextSnowflakeId } from '@/server/snowflake';
import { users, apps, histories, messages, generations, leases, rateLimits } from '@/server/schema';
import { publicUser } from '@/server/auth';
import { generationFor, loadMessages } from '@/server/generation-store';
import { workspace } from '@/server/workspace';
import type { User } from '@/shared/contracts';
import type { WorkspaceApp } from '@/server/workspace';

type Snapshot = { at: number; files: Record<string, string>; suppressed: number; tsconfig: string; viteConfig: string };
type BuildRecord = { index: number; stage: string; repairable: boolean; reason: string; ms: number; error: string; detailChars: number; snapshot: Snapshot };
const observed = vi.hoisted(() => ({
  builds: [] as BuildRecord[],
  transitions: [] as { at: number; what: string }[],
  steps: [] as { total: number; tools: string[]; text: string }[],
  prompts: [] as string[],
  snapshot: null as null | ((app: WorkspaceApp) => Promise<Snapshot>),
}));
const seed = vi.hoisted(() => ({ file: '', marker: 'pendingCouponTotal', mode: 'required' }));

function changedFiles(before: Snapshot | null, after: Snapshot) {
  if (!before) return Object.keys(after.files);
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...paths].filter(path => before.files[path] !== after.files[path]);
}

/**
 * 注入可空解引用。两种模式：
 *  - required（默认）：把「应付总额」里已有的渲染表达式换成可空局部变量，删掉它会丢用户可见信息，
 *    所以只能补保护或还原；用来观察模型是「修好」还是「删掉」。
 *  - spare：新增一行没人要求的可空引用；删掉它是合理修法，用来观察最小改动倾向。
 */
async function injectSeed(root: string, relative: string, mode: string) {
  const target = join(root, relative);
  const source = await readFile(target, 'utf8');
  const declaration = 'const pendingPayable = ref<number | null>(null);';
  const withRef = source.replace('</script>', '\n' + declaration + '\n</script>');
  if (withRef === source) throw new Error(`${relative} 里找不到 </script>，无法注入种子`);
  seed.file = relative;
  if (mode === 'spare') {
    seed.marker = 'pendingCouponTotal';
    const spare = withRef.replace('</script>', '\nconst pendingCouponTotal = ref<number | null>(null);\n</script>');
    const templateAt = spare.indexOf('<template>');
    const rootLineEnd = spare.indexOf('\n', spare.indexOf('>', templateAt) + 1);
    const line = '    <p class="coupon-total">可抵扣合计 {{ pendingCouponTotal.toFixed(2) }}</p>';
    await writeFile(target, spare.slice(0, rootLineEnd + 1) + line + '\n' + spare.slice(rootLineEnd + 1), 'utf8');
    return;
  }
  // 只替换第一处 {{ formatPrice(summary.total) }}：把页面上的应付金额接到一个可能为 null 的变量上。
  const injected = withRef.replace('{{ formatPrice(summary.total) }}', '{{ formatPrice(pendingPayable) }}');
  if (injected === withRef) throw new Error(`${relative} 里找不到 formatPrice(summary.total)，换 EVAL_SEED_MODE=spare 或其它目标文件`);
  seed.marker = 'pendingPayable';
  await writeFile(target, injected, 'utf8');
}

vi.mock('@/server/artifacts', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/artifacts')>();
  const { listProjectFiles, readProjectFileBytes } = await import('@/server/workspace');
  const { classifyBuildFailure, buildFailureOf } = await import('@/server/build-feedback');
  const hash = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex').slice(0, 16);
  const suppressed = /@ts-nocheck|@ts-ignore|@ts-expect-error/g;
  const snapshot = async (app: WorkspaceApp): Promise<Snapshot> => {
    const files: Record<string, string> = {};
    let count = 0;
    for (const path of await listProjectFiles(app)) {
      const bytes = await readProjectFileBytes(app, path);
      files[path] = hash(bytes);
      if (/\.(ts|vue|js|mjs|cjs|json|css|html)$/.test(path)) count += (bytes.toString('utf8').match(suppressed) ?? []).length;
    }
    return { at: Date.now(), files, suppressed: count, tsconfig: files['tsconfig.json'] ?? '', viteConfig: files['vite.config.ts'] ?? '' };
  };
  observed.snapshot = snapshot;
  return {
    ...actual,
    buildApp: async (app: WorkspaceApp, signal?: AbortSignal) => {
      const before = await snapshot(app);
      const started = Date.now();
      try {
        const result = await actual.buildApp(app, signal);
        observed.builds.push({ index: observed.builds.length + 1, stage: 'ok', repairable: false, reason: '', ms: Date.now() - started, error: '', detailChars: 0, snapshot: before });
        return result;
      } catch (error) {
        const verdict = classifyBuildFailure(error);
        const failure = buildFailureOf(error);
        observed.builds.push({ index: observed.builds.length + 1, stage: verdict.stage, repairable: verdict.repairable, reason: verdict.repairable ? '' : verdict.reason, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error), detailChars: failure?.detail?.length ?? 0, snapshot: before });
        throw error;
      }
    },
  };
});

vi.mock('@/server/model', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/model')>();
  /** 代理真实模型，只多记一步：真正发给模型的输入。 */
  const capture = (model: LanguageModel): LanguageModel => typeof model === 'string' ? model : Object.create(model, {
    doStream: { value: async (options: Parameters<LanguageModelV4['doStream']>[0]) => {
      observed.prompts.push(JSON.stringify(options.prompt));
      return (model as LanguageModelV4).doStream(options);
    } },
  }) as LanguageModel;
  return {
    ...actual,
    modelFor: async (...args: Parameters<typeof actual.modelFor>) => capture(await actual.modelFor(...args)),
    modelBindingFor: async (...args: Parameters<typeof actual.modelBindingFor>) => {
      const binding = await actual.modelBindingFor(...args);
      return { ...binding, model: capture(binding.model) };
    },
    taskModelsFor: async (...args: Parameters<typeof actual.taskModelsFor>) => {
      const models = await actual.taskModelsFor(...args);
      return { ...models, model: capture(models.model) };
    },
  };
});

vi.mock('@/server/generation-store', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/generation-store')>();
  return {
    ...actual,
    setGeneration: async (...args: Parameters<typeof actual.setGeneration>) => { observed.transitions.push({ at: Date.now(), what: `status=${args[1]}` }); return actual.setGeneration(...args); },
    restoreGeneration: async (...args: Parameters<typeof actual.restoreGeneration>) => { observed.transitions.push({ at: Date.now(), what: 'restore→generating' }); return actual.restoreGeneration(...args); },
    finishGeneration: async (...args: Parameters<typeof actual.finishGeneration>) => { observed.transitions.push({ at: Date.now(), what: `finish=${args[1]}` }); return actual.finishGeneration(...args); },
    saveMessage: async (...args: Parameters<typeof actual.saveMessage>) => {
      const parts = args[1].parts as { type: string; state?: string; text?: string }[];
      observed.steps.push({
        total: parts.filter(part => part.type.startsWith('tool-')).length,
        tools: parts.filter(part => part.type.startsWith('tool-')).map(part => part.type.replace(/^tool-/, '') + (part.state === 'output-error' ? '(错误)' : '')),
        text: parts.filter(part => part.type === 'text' && part.text).map(part => part.text!).join(' '),
      });
      return actual.saveMessage(...args);
    },
  };
});

loadEnvFile('.env');
const scenario = process.env.EVAL_SCENARIO ?? 'seeded';
const repairRounds = process.env.EVAL_REPAIR_ROUNDS ?? '2';
const prompt = process.env.EVAL_PROMPT ?? (scenario === 'natural'
  ? '做一个记账小应用：首页显示本月收入、支出合计与最近 5 笔流水，可以新增一笔收支（金额、分类、备注），数据存在本地。'
  : '把首页主标题改成「验证构建自动修复」，并在标题下方加一行小字：本页面用于验证构建失败后的自动修复。');
const artifacts = resolve(process.cwd(), 'runtime/eval-repair', new Date().toISOString().replace(/[:.]/g, '-'));
const project = (id: string): WorkspaceApp => ({ id, codeGenType: 'vue_project' });
const seedTargets = ['src/views/CheckoutView.vue', 'src/views/AccountView.vue', 'src/views/ProductDetailView.vue', 'src/views/GalleryView.vue', 'src/App.vue'];

let actor: User;
let appId: string;
let seededPath = '';

async function newestRealProject() {
  if (process.env.EVAL_SEED_PROJECT) return process.env.EVAL_SEED_PROJECT;
  const root = join(process.cwd(), 'runtime/code_output');
  const entries = (await readdir(root).catch(() => [] as string[])).filter(entry => entry.startsWith('vue_project_')).sort().reverse();
  for (const name of entries) {
    const candidate = join(root, name);
    const views = await readdir(join(candidate, 'src/views')).catch(() => null);
    if (views?.includes('AccountView.vue')) return candidate;
  }
  return null;
}

beforeAll(async () => {
  process.env.BUILD_REPAIR_ROUNDS = repairRounds;
  await mkdir(artifacts, { recursive: true });
  const id = await nextSnowflakeId();
  await db().insert(users).values({ id, userAccount: 'eval_repair_' + randomUUID(), userPassword: 'unused', createTime: now(), updateTime: now() });
  const [row] = await db().select().from(users).where(eq(users.id, id));
  actor = publicUser(row);
  const app = await nextSnowflakeId();
  appId = app.toString();
  await db().insert(apps).values({ id: app, initPrompt: '评估修复闭环', codeGenType: 'vue_project', appName: 'eval-repair', userId: BigInt(actor.id), createTime: now(), updateTime: now() });
  const target = workspace(project(appId));
  await rm(target, { recursive: true, force: true });
  const real = scenario === 'natural' ? null : await newestRealProject();
  if (real) {
    seededPath = real;
    await cp(real, target, { recursive: true, filter: source => !/node_modules|\/dist(\/|$)|\.paimeng-(build|dist-)/u.test(source) });
  } else {
    const { initializeTemplate } = await import('@/server/template-workspace');
    await initializeTemplate(project(appId), { id: 'vue-ts', version: '1.0.0' });
  }
});

afterAll(async () => {
  for (const table of [leases, generations, messages, histories]) await db().delete(table).where(eq(table.appId, BigInt(appId)));
  await db().delete(apps).where(eq(apps.id, BigInt(appId)));
  await db().delete(rateLimits).where(eq(rateLimits.limitKey, 'user:' + actor.id));
  await db().delete(users).where(eq(users.id, BigInt(actor.id)));
  await rm(workspace(project(appId)), { recursive: true, force: true });
  await getPool().end();
  console.log('\n评估产物（报告、模型输入、SSE）：' + artifacts);
});

it(scenario === 'natural' ? '自然生成：观察是否触发修复轮' : '真实类型错误：修复轮仅凭诊断修好它没写过的文件', async () => {
  const { buildApp } = await import('@/server/artifacts');
  const { classifyBuildFailure } = await import('@/server/build-feedback');
  // 1) 基线：注入之前，这份真实工程必须能构建通过——因此后面那次失败只可能来自注入。
  const baselineError = await buildApp(project(appId)).then(() => null, (error: unknown) => error);
  const baseline = { stage: baselineError ? classifyBuildFailure(baselineError).stage : 'ok', ms: observed.builds[0].ms };
  let preModel: Snapshot | null = null;
  if (scenario !== 'natural') {
    const mode = process.env.EVAL_SEED_MODE ?? 'required';
    const target = seedTargets[0];
    await injectSeed(workspace(project(appId)), target, mode);
    seed.mode = mode;
    preModel = await observed.snapshot!(project(appId));
  }

  // 2) 真实模型跑一次生成。
  const requestId = randomUUID();
  const response = await chatResponse(
    new Request('http://localhost:3000/api/app/chat/gen/code', { method: 'POST' }),
    { appId, requestId, message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: prompt }] } },
    actor,
  );
  const stream = await response.text();
  const task = await generationFor(appId);
  const stored = await loadMessages(appId);
  const finalSource = await readFile(join(workspace(project(appId)), seed.file), 'utf8').catch(() => '');

  const rounds = observed.builds.slice(1).map((build, index) => ({
    ...build,
    round: index + 1,
    // 第 1 轮要比的是注入之后的快照：否则注入本身会被算成模型的改动。
    changed: changedFiles(index === 0 ? preModel : observed.builds[index].snapshot, build.snapshot),
    tsconfigChanged: observed.builds[index].snapshot.tsconfig !== build.snapshot.tsconfig,
    suppressedDelta: build.snapshot.suppressed - observed.builds[index].snapshot.suppressed,
  }));
  const deltas = observed.steps.map((step, index) => ({ ...step, added: step.tools.slice(index === 0 ? 0 : observed.steps[index - 1].total) }));
  const repairDiagnostics = observed.prompts.map(input => input.includes('验证未通过')).filter(Boolean).length;
  const lastPrompt = observed.prompts.at(-1) ?? '[]';
  const reasoning = (JSON.parse(lastPrompt) as { role: string; content: unknown }[])
    .flatMap(message => message.role === 'assistant' && Array.isArray(message.content)
      ? (message.content as { type: string; text?: string }[]).filter(part => part.type === 'reasoning').map(part => part.text ?? '')
      : [])
    .join(' ')
    .slice(0, 1200);
  const report = {
    scenario, repairRounds, prompt, seedProject: seededPath || '(模板空工程)', injected: { file: seed.file, marker: seed.marker, mode: seed.mode, survivedRound1: rounds[0]?.error.includes(seed.marker) ?? false },
    baseline, final: { status: task?.status ?? null, error: task?.error ?? null },
    builds: rounds, transitions: observed.transitions,
    steps: deltas.map(step => ({ added: step.added, text: step.text.slice(0, 200) })),
    totalSteps: stored.at(-1)?.parts.filter(part => part.type === 'step-start').length ?? 0,
    storedMessages: stored.length,
    repairEvents: (stream.match(/"type":"data-build"/g) ?? []).length,
    repairDiagnostics,
    inputChars: observed.prompts.map(input => input.length),
    finalSource: { stillReferencesMarker: finalSource.includes(seed.marker), keeps原有的表达式: finalSource.includes('formatPrice(summary.total)'), hasNullGuard: /pendingPayable\s*\?\?/.test(finalSource) },
    repairReasoning: reasoning,
  };
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(join(artifacts, 'stream.sse'), stream, 'utf8');
  for (const [index, input] of observed.prompts.entries()) await writeFile(join(artifacts, `model-input-${index + 1}.json`), input, 'utf8');

  console.log('\n================ 修复闭环评估 ================');
  console.log(`场景=${scenario} 修复轮上限=${repairRounds} 种子工程=${seededPath || '(模板空工程)'}`);
  console.log(`注入=${seed.file}（${seed.mode}，标记 ${seed.marker}，活过第 1 轮=${report.injected.survivedRound1}）`);
  console.log(`① 基线构建（注入前）：stage=${baseline.stage} 耗时=${baseline.ms}ms`);
  for (const build of rounds) console.log(`② 第 ${build.round} 次构建：stage=${build.stage} 可修复=${build.repairable || build.stage === 'ok'} 耗时=${build.ms}ms 本轮改动=${build.changed.join(', ') || '(无)'} tsconfig改动=${build.tsconfigChanged} 抑制注释增量=${build.suppressedDelta}\n   ${build.error.slice(0, 300) || '(通过)'}`);
  console.log(`③ 每步新增工具：${deltas.map(step => step.added.length ? step.added.length + '×' + step.added.join('/') : '文本').join(' → ')}`);
  console.log(`④ 状态转移：${observed.transitions.map(transition => transition.what).join(' → ')}`);
  console.log(`⑤ 最终：status=${report.final.status} error=${report.final.error ?? '(无)'} 修复事件=${report.repairEvents} 发给模型的诊断=${repairDiagnostics} 落库消息=${report.storedMessages} 步数=${report.totalSteps}`);
  console.log(`⑥ 修复后源码：仍引用标记=${report.finalSource.stillReferencesMarker} 还原成原表达式=${report.finalSource.keeps原有的表达式} 加了空值保护=${report.finalSource.hasNullGuard}`);
  console.log(`⑦ 上下文体积：${report.inputChars.map(chars => Math.round(chars / 1024) + 'KB').join(' → ')}`);
  if (reasoning) console.log(`⑧ 修复轮模型自述：${reasoning.slice(0, 500)}`);
  console.log('=============================================\n');

  if (scenario === 'natural') return;
  // 只断言「实验有效」与「机制不变式」：基线必须能构建；注入的缺陷如果活过第 1 轮，第 1 轮就必须
  // 是可修复的类型检查失败、且修复轮必须真的发生过。修复是否成功写在报告里，不用断言替它下结论。
  expect(baseline.stage).toBe('ok');
  if (report.injected.survivedRound1) {
    expect(rounds[0]?.stage).toBe('typecheck');
    expect(report.repairEvents).toBeGreaterThan(0);
  }
});
