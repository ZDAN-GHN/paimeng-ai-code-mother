import 'server-only';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, now, type Transaction } from '../infra/db';
import { getConfig } from '../infra/config';
import { BusinessError } from '../infra/http';
import { isProjectCodeGenType, type GenerationStopReason } from '@/shared/contracts';
import type { TemplateIdentity } from '@/shared/templates';
import {
  appAuthority, appPreviewPointers, apps, generationDeliveries, generationExecutions, generationInputs,
  generationQuestions, generationTransitions, generations, sourceSnapshots, versionRecords,
  type AuthorityState, type InputMode, type InputStatus,
} from '../infra/schema';
import {
  acquireAuthority, beginChecking, beginDrain, closeQuestion, createExecution, finishDrain, getDraft,
  invalidatedCandidateWatermark, markInputUnanswered, openQuestionOf, releaseAuthority, reopenExecution,
  sealExecution as sealExecutionRecord, setDraft, setExecutionStatus,
  type ExecutionRecord, type InputRecord, type QuestionRecord,
} from './control-store';
import { generationControl, lockGenerationControl, type GenerationControl } from './generation-store';
// 计费只从 generation 侧 import billing：billing 反向 import 本模块会成环。
import { settleGenerationBilling } from '../billing/settlement';
import { assertCanStartGeneration } from '../billing/quota';
import {
  closeExecutionAndDrain, openExecution, prepareExecution, sealExecution,
  type ExecutionBaseline, type ExecutionRef,
} from '../workspace/execution-workspace';
import { createDelivery, currentDelivery, setCurrentDelivery } from '../delivery/delivery-store';
import {
  emptyVersionRepo, headVersionSha, materializeVersionTo, prepareVersionCommit, syncVersionWorkspace, versionObjectExists,
  type PreparedVersion,
} from '../versioning/version-store';
import { resolveTemplate, readTemplateIdentity } from '../templates/templates';
import { listVersionRows } from '../versioning/version-ledger';
import { ensureSafeDirectory, workspace, type WorkspaceApp } from '../workspace/workspace';

/**
 * 「一次生成」的生命周期编排层（docs/plans/archive/harness-reliability.md §1/§2/§5，迁移 006）。
 *
 * 把四个已有能力串成一条可恢复的流程，本模块只做数据库 + 文件/Git 编排：
 *   ControlStore    准入、epoch、输入状态、终态与原子发布校验
 *   Workspace       固定执行目录、基线复制、排空与源码封存
 *   VersionStore    源码快照 → Git 提交（只构造，不落台账）
 *   Delivery/Preview 不可变交付目录与预览指针
 *
 * 边界纪律：
 * 1. 不调用 provider/harness，不做构建/验收，不接 Next 或 durable-engine。
 * 2. 事务内不执行 Git、文件系统、构建；所有慢操作都在事务外，失败靠本模块的补偿与恢复收敛。
 * 3. 多行加锁固定顺序 app → authority → generation → attempt，与 control-store 完全一致。
 * 4. 「过期」一律用数据库时钟判断；应用进程的时钟不参与任何准入判断。
 * 5. 已发布/已终态的 generation 不被覆盖：发布先提交则取消返回 already-published，取消先提交则发布被拒绝。
 * 6. 一切失败路径都不把 authority 停在 active：要么明确 failed/ready 后回 idle，要么留在 draining 交给恢复。
 * 7. 没有源码改动（纯问答、只跑了构建）按 ready/finished 收束，返回 published=false，不算失败。
 */

const activeStatuses = ['generating', 'building'];
/** 未结算的输入状态：accepted/placed/unanswered 都算没结算，withdrawn 算结算。 */
const unsettledInputStatuses: InputStatus[] = ['accepted', 'placed', 'unanswered'];
const defaultDrainTimeoutMs = 10_000;
/** 交付源码目录不接受的平台文件：交付清单本身与平台元数据。 */
const deliverySourcePlatformSkipped = /^(?:\.paimeng-|\.env)/;
const maxDeliverySourceDepth = 20;

/** 执行基线的内容来源：优先级固定为草稿 → 版本 → 模板 → 空。 */
export type GenerationBaseline = {
  kind: 'draft' | 'version' | 'template' | 'workspace' | 'empty';
  /** 草稿快照 id（kind=draft）。 */
  snapshotId?: string;
  /** 草稿快照目录（kind=draft）。 */
  directory?: string;
  /** 版本提交 SHA（kind=version）。 */
  versionSha?: string;
  /** 模板标识（kind=template）。 */
  templateId?: string;
  templateVersion?: string;
};

export type StartGenerationInput = {
  app: WorkspaceApp;
  /** 提交本轮的用户；必须是应用所有者。 */
  userId: string;
  /** 幂等键：(app, requestId) 只对应一条 start 输入。 */
  requestId: string;
  /** 取得 authority 的进程标识。 */
  holder: string;
  prompt: string;
  /** 版本基线/父提交；不给时用草稿快照的父版本，再退回版本仓库 HEAD。 */
  parentVersionSha?: string | null;
  /** 绝对截止时间；不传用 GENERATION_TIMEOUT_MS，显式 null 表示无截止时间。 */
  deadline?: string | Date | null;
  runtimeRoot?: string;
  snapshotsRoot?: string;
  /** 模板基线；不传时读应用工作区里的模板标识，显式 null 表示不要模板基线。 */
  template?: TemplateIdentity | null;
  /**
   * 回答提问：要给等待中的问题 id。给了就用 answer 模式的输入开新一轮，并在同一事务里消费该提问；
   * 没给而应用有开放提问时直接 409，避免悄悄把提问晾着。
   */
  expectedQuestionId?: string | null;
  /** 显式声明这次 start 是在回答提问（默认按是否给了 expectedQuestionId 判断）。 */
  answer?: boolean;
  ttlMs?: number;
};

export type StartGenerationResult = {
  generationId: string;
  /** 幂等重放时为原执行的 epoch；初始化没有走到执行行时为 null。 */
  epoch: number | null;
  executionId: string | null;
  execution: ExecutionRecord | null;
  input: InputRecord;
  status: string;
  baseline: GenerationBaseline;
  previousDraftSnapshotId: string | null;
  /** true 表示 (app, requestId) 已存在，这次没有新建任何东西。 */
  replay: boolean;
  /** 这次 start 回答并消费掉的提问（不是回答时为 null）。 */
  answeredQuestionId: string | null;
};

export type PublishReadyInput = {
  app: WorkspaceApp;
  generationId: string;
  epoch: number;
  /** start 返回的执行（用目录关闸/封存，用 id 收束执行行）。 */
  execution: { id: string; directory: string };
  title: string;
  messageId?: string | null;
  parentVersionSha?: string | null;
  /** 交付源码目录：工程类型一般是 <exec>/dist，静态类型是执行目录或快照目录；不给走默认。 */
  buildDirectory?: string;
  runtimeRoot?: string;
  snapshotsRoot?: string;
  drainTimeoutMs?: number;
};

/**
 * 发布结果：本轮没有源码改动（纯问答、只跑了构建）时 published=false，
 * 这种情况仍然是正常收束（ready/finished），不是失败终态。
 */
export type PublishOutcome = {
  published: boolean;
  reason: 'no-source-change' | null;
  version: { sha: string; title: string; changedFiles: string[] } | null;
  delivery: { id: string; directory: string } | null;
  /** app_preview_pointer 的 revision（数据库是权威，文件指针是它的派生）。 */
  revision: number;
  alreadyPublished: boolean;
};

export type PublishReadyResult = PublishOutcome & {
  /** 事务后写文件指针是否成功；false 表示需要 recover 补写（数据库已提交）。 */
  previewSynced: boolean;
};

/**
 * checking/publishing 期间接受了新输入：旧候选不能发布，但这不是生成失败。
 * 调用方应回到 editing 继续消费输入，而不是走失败/取消收束。
 */
export class CandidateInvalidatedError extends BusinessError {
  constructor(message = '新输入已使发布候选失效，本轮需要重新生成') {
    super(409, 40900, message);
    this.name = 'CandidateInvalidatedError';
  }
}

export type FailOrCancelInput = {
  app: WorkspaceApp;
  generationId: string;
  epoch: number;
  execution: { id: string; directory: string };
  outcome: 'failed' | 'cancelled';
  error: string;
  stopReason?: GenerationStopReason | null;
  messageId?: string | null;
  runtimeRoot?: string;
  snapshotsRoot?: string;
  drainTimeoutMs?: number;
};

export type FailOrCancelResult = { draftSnapshotId: string | null; alreadyTerminal: boolean; status: string };

export type PauseForQuestionInput = {
  app: WorkspaceApp;
  generationId: string;
  epoch: number;
  execution: { id: string; directory: string };
  messageId?: string | null;
  runtimeRoot?: string;
  snapshotsRoot?: string;
  drainTimeoutMs?: number;
};

export type PauseForQuestionResult = { draftSnapshotId: string | null; alreadyTerminal: boolean; status: string };

export type RecoveredGeneration = {
  generationId: string;
  status: string;
  draftSnapshotId: string | null;
  executionId: string | null;
  /** true 表示这次真的封存（或复用了同一代的草稿快照）。 */
  sealed: boolean;
  errors: string[];
};

/** checking/publishing 阶段的待对账记录：本模块不擅自发布，也不改它的状态。 */
export type PendingReconciliation = { generationId: string; status: string; phase: string };

export type RecoverySummary = {
  appId: string;
  authority: { epoch: number; state: AuthorityState; expired: boolean; action: string } | null;
  recovered: RecoveredGeneration[];
  pending: PendingReconciliation[];
  previewRepaired: boolean;
  errors: string[];
};

export type RecoveryStartupSummary = {
  holder: string;
  apps: number;
  recovered: number;
  pending: number;
  errors: string[];
  summaries: RecoverySummary[];
};

export type GenerationInputView = {
  id: string; appId: string; generationId: string; seq: number; requestId: string; mode: InputMode; message: string;
  status: InputStatus; sdkSubmissionId: number | null; sdkEntryId: string | null; createTime: string; updateTime: string;
};

// ---------------------------------------------------------------------------------------------------
// 校验与转换
// ---------------------------------------------------------------------------------------------------

function appKey(appId: string): bigint {
  try {
    return BigInt(appId);
  } catch {
    throw new BusinessError(404, 40400, '应用不存在');
  }
}

function idKey(value: string, message: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new BusinessError(400, 40000, message);
  }
}

function requiredText(value: string, message: string, maxLength?: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new BusinessError(400, 40000, message);
  if (maxLength !== undefined && text.length > maxLength) throw new BusinessError(400, 40000, message);
  return value;
}

/** generation.parent_version_sha 是 CHAR(40)：只接受完整提交 SHA 或空。 */
function normaliseSha(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (!text) return null;
  if (!/^[0-9a-f]{40}$/.test(text)) throw new BusinessError(400, 40000, '父版本必须是完整的提交标识');
  return text;
}

/** 数据库时间是 UTC 朴素时间戳：显式 deadline 也要按同一格式写入。 */
function naiveTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) throw new BusinessError(400, 40000, '截止时间不合法');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 1000);
}

function uniqueViolation(error: unknown): boolean {
  const coded = error as { cause?: { code?: string }; code?: string };
  return (coded.cause?.code ?? coded.code) === '23505';
}

function executionView(row: typeof generationExecutions.$inferSelect): ExecutionRecord {
  return {
    id: row.id, appId: String(row.appId), generationId: row.generationId, conversationId: row.conversationId,
    epoch: row.epoch, directory: row.directory, baselineKind: row.baselineKind,
    baselineSnapshotId: row.baselineSnapshotId, baselineVersionSha: row.baselineVersionSha, status: row.status,
    createTime: row.createTime, updateTime: row.updateTime,
  };
}

function inputView(row: typeof generationInputs.$inferSelect): InputRecord {
  return {
    id: row.id, appId: String(row.appId), generationId: row.generationId, seq: row.seq, requestId: row.requestId,
    mode: row.mode, message: row.message, status: row.status, sdkSubmissionId: row.sdkSubmissionId,
    sdkEntryId: row.sdkEntryId, createTime: row.createTime, updateTime: row.updateTime,
  };
}

function questionView(row: typeof generationQuestions.$inferSelect): QuestionRecord {
  return {
    id: row.id, appId: String(row.appId), generationId: row.generationId, prompt: row.prompt,
    status: row.status, answerInputId: row.answerInputId, createTime: row.createTime, updateTime: row.updateTime,
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------
// 事务内的锁与登记（顺序固定：app → authority → generation）
// ---------------------------------------------------------------------------------------------------

async function lockAppRow(tx: Transaction, appId: string) {
  const [row] = await tx.select().from(apps).where(and(eq(apps.id, appKey(appId)), eq(apps.isDelete, 0))).for('update');
  if (!row) throw new BusinessError(404, 40400, '应用不存在');
  return row;
}

/** authority 行是每个 app 的永久记录：没有就建一条 idle，再按固定顺序取行锁。 */
async function lockAuthorityRow(tx: Transaction, appId: bigint) {
  await tx.insert(appAuthority).values({ appId, updateTime: now() }).onConflictDoNothing();
  const [row] = await tx.select().from(appAuthority).where(eq(appAuthority.appId, appId)).for('update');
  return row;
}

/**
 * 登记一条源码快照：先按 (应用, 生成, 类型, 目录) 去重，重试不会给同一份目录登记第二行。
 * 发布事务里传入 tx，与版本/交付/指针一起原子提交。
 */
async function registerSnapshot(input: {
  appId: bigint; generationId: string; kind: 'draft' | 'version'; parentVersionSha: string | null;
  digest: string; directory: string; message: string | null;
  tx?: Transaction;
}): Promise<string> {
  const scope = and(
    eq(sourceSnapshots.appId, input.appId), eq(sourceSnapshots.generationId, input.generationId),
    eq(sourceSnapshots.kind, input.kind), eq(sourceSnapshots.directory, input.directory),
  );
  const [existing] = input.tx
    ? await input.tx.select({ id: sourceSnapshots.id }).from(sourceSnapshots).where(scope).limit(1)
    : await db().select({ id: sourceSnapshots.id }).from(sourceSnapshots).where(scope).limit(1);
  if (existing) return existing.id;
  const id = randomUUID();
  const values = {
    id, appId: input.appId, generationId: input.generationId, kind: input.kind,
    parentVersionSha: input.parentVersionSha, digest: input.digest, directory: input.directory,
    status: 'sealed' as const, message: input.message, createTime: now(), updateTime: now(),
  };
  if (input.tx) await input.tx.insert(sourceSnapshots).values(values);
  else await db().insert(sourceSnapshots).values(values);
  return id;
}

/** 同一次执行最多一份快照：任何类型、已封存、目录还在，就是可复用的那份。 */
async function registeredSnapshot(appId: bigint, generationId: string): Promise<{ id: string; directory: string; digest: string } | null> {
  const [row] = await db().select({ id: sourceSnapshots.id, directory: sourceSnapshots.directory, digest: sourceSnapshots.digest })
    .from(sourceSnapshots)
    .where(and(
      eq(sourceSnapshots.appId, appId), eq(sourceSnapshots.generationId, generationId),
      eq(sourceSnapshots.status, 'sealed'),
    ))
    .orderBy(desc(sourceSnapshots.createTime))
    .limit(1);
  return row ?? null;
}

/**
 * 同一次执行只封存一次：已登记的快照目录还在就直接复用。
 * 发布重试与「先发布失败、再取消」都会走到这里，不能因为快照目录已存在就卡死。
 *
 * 这里还要合并**并发**封存：观察者收尾与失败补偿可能同时到达同一个 generation。
 * 只靠「先查数据库」挡不住，因为封存目录写完到登记快照之间没有原子锁；两个调用会
 * 同时写 `<snapshot>.tmp/manifest.json`，其中一个必然 EEXIST，随后整轮发布失败。
 * 共享同一个 Promise 后，第二个调用拿到第一份封存结果，再走各自的幂等事务。
 */
const sealingSources = ((globalThis as typeof globalThis & {
  paimengSealingSources?: Map<string, Promise<{ id: string | null; directory: string; digest: string }>>;
}).paimengSealingSources ??= new Map());

async function sealSource(input: {
  app: WorkspaceApp;
  ref: ExecutionRef;
  snapshotsRoot?: string;
}): Promise<{ id: string | null; directory: string; digest: string }> {
  const snapshotsRoot = resolve(input.snapshotsRoot ?? join(getConfig().runtimeRoot, 'snapshots'));
  const key = `${input.app.id}:${input.ref.generationId}:${input.ref.epoch}:${snapshotsRoot}`;
  const existing = await registeredSnapshot(appKey(input.app.id), input.ref.generationId);
  if (existing && await directoryExists(existing.directory)) return existing;
  const pending = sealingSources.get(key);
  if (pending) return pending;
  const work = (async () => {
    try {
      const sealed = await sealExecution({
        app: input.app, ref: input.ref, snapshotsRoot, generationId: input.ref.generationId,
      });
      return { id: null, directory: sealed.directory, digest: sealed.digest };
    } catch (error) {
      // 另一个 Next 进程/模块实例可能已经赢得了同一个最终目录；共享失败本身不是数据错误，
      // 只要清单完整就复用这份不可变快照，不能把 EEXIST 当成生成失败。
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR' && !message.includes('快照目录已存在')) throw error;
      const directory = join(snapshotsRoot, `${input.app.codeGenType}_${input.app.id}`, `${input.ref.generationId}_${input.ref.epoch}`);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { version?: unknown; digest?: unknown };
          if (manifest.version === 1 && typeof manifest.digest === 'string') return { id: null, directory, digest: manifest.digest };
        } catch {
          // 赢家可能还在复制/写清单；短暂等待后重读，超时仍然抛原始错误。
        }
        await new Promise(done => setTimeout(done, 50));
      }
      throw error;
    }
  })();
  sealingSources.set(key, work);
  try {
    return await work;
  } finally {
    // 进程内只合并并发调用，不永久缓存已完成的 Promise；封存与登记数据库之间的窗口由
    // 下面的“最终目录已存在就复用清单”兜底，避免长跑进程为每个 generation 留一份缓存。
    if (sealingSources.get(key) === work) sealingSources.delete(key);
  }
}

/** 草稿引用：同一目录已经有快照行就复用那一行（草稿与发布源码快照是同一份内容）。 */
async function ensureDraftSnapshot(input: {
  appId: bigint; generationId: string; parentVersionSha: string | null;
  sealed: { directory: string; digest: string }; message: string;
}): Promise<string> {
  const existing = await registeredSnapshot(input.appId, input.generationId);
  if (existing && existing.directory === input.sealed.directory) return existing.id;
  return registerSnapshot({
    appId: input.appId, generationId: input.generationId, kind: 'draft', parentVersionSha: input.parentVersionSha,
    digest: input.sealed.digest, directory: input.sealed.directory, message: input.message,
  });
}

// ---------------------------------------------------------------------------------------------------
// 1. startGeneration
// ---------------------------------------------------------------------------------------------------

/** 幂等键查询：同一 (app, requestId) 只对应一条 start 输入。 */
async function startInputOf(appId: bigint, requestId: string) {
  const [row] = await db().select().from(generationInputs)
    .where(and(eq(generationInputs.appId, appId), eq(generationInputs.requestId, requestId)));
  return row ? inputView(row) : null;
}

/**
 * 建 generation 行与 seq=1 的输入。
 *
 * 只在已经拿到 authority 之后调用：抢写权限失败的一方不会留下任何 generation 行，
 * 否则 generationFor（按 createTime desc 取最新）会把正在跑的任务状态遮住。
 *
 * 回答提问（`questionId` 非空）时，消费提问与建行在同一事务里完成：提问变 answered、
 * 回答输入直接置 resolved，不会出现「问题已消费但新一轮没开」或反过来的中间态。
 */
async function insertGeneration(input: {
  appId: bigint; generationId: string; userId: bigint; requestId: string; prompt: string;
  parentVersionSha: string | null; deadline: SQL | string | null;
  /** 非空表示这次 start 是在回答该提问。 */
  questionId: string | null;
}): Promise<{ input: InputRecord; answeredQuestionId: string | null }> {
  try {
    return await db().transaction(async tx => {
      const appRow = await lockAppRow(tx, String(input.appId));
      if (appRow.userId !== input.userId) throw new BusinessError(403, 40300, '无权限生成该应用');
      const [existing] = await tx.select({ id: generationInputs.id }).from(generationInputs)
        .where(and(eq(generationInputs.appId, input.appId), eq(generationInputs.requestId, input.requestId))).for('update');
      if (existing) throw new BusinessError(409, 40900, '同一请求号已存在');
      // 提问与 start 互斥：有开放提问时只能以回答方式开新轮，回答则要求提问仍开放。
      const [open] = await tx.select({ id: generationQuestions.id }).from(generationQuestions)
        .where(and(eq(generationQuestions.appId, input.appId), eq(generationQuestions.status, 'open')))
        .orderBy(desc(generationQuestions.createTime)).limit(1).for('update');
      if (input.questionId === null) {
        if (open) throw new BusinessError(409, 40900, '请先回答当前问题');
      } else if (!open || open.id !== input.questionId) {
        throw new BusinessError(409, 40900, '当前没有等待回答的问题，可能已经被回答或关闭');
      }
      await tx.insert(generations).values({
        id: input.generationId, appId: input.appId, userId: input.userId, status: 'generating',
        createTime: now(), updateTime: now(),
      });
      // 006 的新列不进 schema.ts：phase/deadline/水位/父版本用原生列写。
      await tx.execute(sql`update generation
        set phase = 'editing', input_watermark = 0, parent_version_sha = ${input.parentVersionSha}, deadline = ${input.deadline}
        where id = ${input.generationId}`);
      const [row] = await tx.insert(generationInputs).values({
        id: randomUUID(), appId: input.appId, generationId: input.generationId, seq: 1, requestId: input.requestId,
        mode: input.questionId === null ? 'start' : 'answer', message: input.prompt,
        // 回答在消费提问的同一事务里结算：它不会排到下一轮，也不需要 SDK 回执。
        status: input.questionId === null ? 'accepted' : 'resolved',
        createTime: now(), updateTime: now(),
      }).returning();
      if (input.questionId !== null) {
        await tx.update(generationQuestions)
          .set({ status: 'answered', answerInputId: row.id, updateTime: now() })
          .where(eq(generationQuestions.id, input.questionId));
      }
      await tx.insert(generationTransitions).values({
        appId: input.appId, generationId: input.generationId, fromState: null, toState: 'generating',
        reason: input.questionId === null ? '用户提交生成' : '用户回答问题', createTime: now(),
      });
      return { input: inputView(row), answeredQuestionId: input.questionId };
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new BusinessError(409, 40900, '同一请求号已存在');
    throw error;
  }
}

/**
 * 解析内容基线：草稿快照 → 版本（显式父版本或仓库 HEAD）→ 模板 → 空。
 * 必须在取得 authority 之后调用：只有持有写权限时草稿引用才是稳定的。
 */
async function resolveBaseline(input: {
  app: WorkspaceApp;
  previousDraftSnapshotId: string | null;
  explicitParentSha: string | null;
  template: TemplateIdentity | null | undefined;
}): Promise<{ baseline: GenerationBaseline; execution: ExecutionBaseline; parentVersionSha: string | null }> {
  const { app, explicitParentSha } = input;
  if (input.previousDraftSnapshotId) {
    const [snapshot] = await db().select().from(sourceSnapshots)
      .where(and(eq(sourceSnapshots.id, input.previousDraftSnapshotId), eq(sourceSnapshots.appId, appKey(app.id))));
    if (!snapshot) throw new Error('草稿快照登记不存在，不能作为执行基线');
    if (snapshot.status !== 'sealed') throw new Error('草稿快照尚未封存完成，不能作为执行基线');
    if (!await directoryExists(snapshot.directory)) throw new Error('草稿快照目录不存在，不能作为执行基线');
    return {
      baseline: { kind: 'draft', snapshotId: snapshot.id, directory: snapshot.directory },
      execution: { kind: 'directory', directory: snapshot.directory },
      // 显式父版本优先：调用方明确要求接在某一版后面时，历史以它为准。
      parentVersionSha: explicitParentSha ?? snapshot.parentVersionSha ?? null,
    };
  }
  if (explicitParentSha) {
    if (await emptyVersionRepo(app)) throw new Error('版本仓库不存在，不能以指定版本为基线');
    if (!await versionObjectExists(app, explicitParentSha)) throw new Error('指定的父版本不存在，不能作为执行基线');
    return {
      baseline: { kind: 'version', versionSha: explicitParentSha },
      execution: {
        kind: 'version', commitSha: explicitParentSha,
        materialize: async target => { await materializeVersionTo({ app, versionId: explicitParentSha, target }); },
      },
      parentVersionSha: explicitParentSha,
    };
  }
  // HEAD 是「工作区当前检出的那一版」（回退后就是旧的），比台账最新一版更贴近真实起点；
  // 发布链路不移动 HEAD，所以没有 HEAD 时退回台账最新一版，下一轮仍然承接已提交历史。
  const head = await headVersionSha(app);
  const latest = head ? null : ((await listVersionRows(app.id, { limit: 1 }))[0]?.commitSha ?? null);
  const baseSha = head ?? latest;
  if (baseSha) {
    return {
      baseline: { kind: 'version', versionSha: baseSha },
      execution: {
        kind: 'version', commitSha: baseSha,
        materialize: async target => { await materializeVersionTo({ app, versionId: baseSha, target }); },
      },
      parentVersionSha: baseSha,
    };
  }
  const identity = input.template === undefined ? await readTemplateIdentity(workspace(app)) : input.template;
  if (identity) {
    const template = resolveTemplate(identity.id, identity.version);
    if (template.codeGenType !== app.codeGenType) throw new Error('模板与应用类型不匹配');
    return {
      baseline: { kind: 'template', templateId: identity.id, templateVersion: identity.version },
      execution: { kind: 'template', identity: { id: identity.id, version: identity.version } },
      parentVersionSha: null,
    };
  }
  // 升级前就存在的应用没有版本/草稿/模板行：把当前工作区当成 legacy 基线复制，不能从空目录开始。
  const legacy = workspace(app);
  if (await directoryExists(legacy) && (await readdir(legacy).catch(() => [])).some(name => !name.startsWith('.'))) {
    return {
      baseline: { kind: 'workspace', directory: legacy },
      execution: { kind: 'directory', directory: legacy },
      parentVersionSha: null,
    };
  }
  return { baseline: { kind: 'empty' }, execution: { kind: 'empty' }, parentVersionSha: null };
}

/** 草稿/HEAD 解析出的父版本要写回 generation，供发布事务做父提交校验。 */
async function setParentVersion(input: { appId: string; generationId: string; epoch: number; parentVersionSha: string | null }): Promise<void> {
  await db().transaction(async tx => {
    const appRow = await lockAppRow(tx, input.appId);
    const authority = await lockAuthorityRow(tx, appRow.id);
    if (authority.ownerEpoch !== input.epoch) throw new BusinessError(409, 40900, '应用写权限已失效');
    await tx.execute(sql`update generation set parent_version_sha = ${input.parentVersionSha}, update_time = ${now()}
      where id = ${input.generationId} and status in ('generating', 'building')`);
  });
}

/** 初始化失败：先撤 epoch（如果已经拿到），再把 generation 收敛成 failed/initialization-failed，最后交回 idle。 */
async function failInitialization(input: { appId: string; generationId: string; epoch: number | null; error: unknown }): Promise<void> {
  const { appId, generationId, epoch } = input;
  const message = messageOf(input.error);
  if (epoch !== null) {
    await beginDrain({ appId, epoch, generationId, reason: '初始化失败' }).catch(() => false);
  }
  await settleGeneration({ appId, generationId, epoch, outcome: 'failed', error: message, stopReason: 'initialization-failed' })
    .catch(() => undefined);
  if (epoch !== null) {
    // 草稿为 null 时 finishDrain 保留原有引用，不回退成「没有草稿」。
    await finishDrain({ appId, epoch, draftSnapshotId: null }).catch(() => false);
  }
}

export async function startGeneration(input: StartGenerationInput): Promise<StartGenerationResult> {
  const { app } = input;
  const appId = appKey(app.id);
  const requestId = requiredText(input.requestId, '缺少请求号', 128);
  const holder = requiredText(input.holder, '缺少持有者标识', 200);
  const prompt = requiredText(input.prompt, '消息不能为空');
  const userId = idKey(input.userId, '用户标识不合法');
  const explicitParentSha = normaliseSha(input.parentVersionSha);
  const expectedQuestionId = input.expectedQuestionId === undefined || input.expectedQuestionId === null
    ? null
    : requiredText(input.expectedQuestionId, '提问标识不合法', 64);
  // 回答 = 带 expectedQuestionId（或调用方显式声明 answer）。声明了 answer 却没有 id 就不猜是哪个问题。
  const answering = input.answer === true || expectedQuestionId !== null;
  if (input.answer === true && expectedQuestionId === null) throw new BusinessError(400, 40000, '回答提问时必须给出要回答的问题标识');
  const timeoutMs = getConfig().generationTimeoutMs;
  const deadline: SQL | string | null = input.deadline === undefined
    ? (timeoutMs > 0 ? sql`(timezone('UTC', now()) + make_interval(secs => ${timeoutMs / 1000}))` : null)
    : input.deadline === null ? null : naiveTime(input.deadline);

  // 先验鉴权再抢写权限：越权请求不能因为 acquire 成功而把正在生成的 owner 顶掉。
  const [owner] = await db().select({ userId: apps.userId }).from(apps)
    .where(and(eq(apps.id, appId), eq(apps.isDelete, 0)));
  if (!owner) throw new BusinessError(404, 40400, '应用不存在');
  if (owner.userId !== userId) throw new BusinessError(403, 40300, '无权限生成该应用');

  // 幂等先看：同一 requestId 已经有 generation 就直接回放，不去抢写权限。
  const replayInput = await startInputOf(appId, requestId);
  if (replayInput) {
    if ((replayInput.mode !== 'start' && replayInput.mode !== 'answer') || replayInput.message !== prompt) {
      throw new BusinessError(409, 40900, '同一请求号已用于其他输入');
    }
    return replayStart(app, replayInput);
  }

  // 提问与 start 互斥：有开放提问时只能回答（带 expectedQuestionId），回答则要求提问仍开放。
  // 这里先给友好 409；真正的一致性由 insertGeneration 的事务（锁住提问行）保证。
  const openQuestion = await openQuestionOf(app.id);
  if (expectedQuestionId === null) {
    if (openQuestion) throw new BusinessError(409, 40900, '请先回答当前问题');
  } else if (!openQuestion || openQuestion.id !== expectedQuestionId) {
    throw new BusinessError(409, 40900, '当前没有等待回答的问题，可能已经被回答或关闭');
  }

  // 保持对外契约：UUID requestId 直接当 generation.id；更长的幂等键退回随机 ID，不撑破 varchar(36)。
  const generationId = requestId.length <= 36 ? requestId : randomUUID();

  // 准入：权限与提问状态都通过之后、抢写权限之前判定可用额度。
  // 放在这里有两个理由：被拒的请求不建 generation/authority/execution 行，也不启动上游模型；
  // 而且不占住写权限——额度不足的一方不能把正在生成的 holder 顶掉。重放已在上面返回，不走这里。
  await assertCanStartGeneration(String(userId));

  let epoch: number | null = null;
  let created = false;
  try {
    // 先抢写权限：被占用时以 409 失败，且这次不会写任何 generation 行。
    const handle = await acquireAuthority({ appId: app.id, generationId, holder, ttlMs: input.ttlMs });
    epoch = handle.epoch;
    const inserted = await insertGeneration({
      appId, generationId, userId, requestId, prompt, parentVersionSha: explicitParentSha, deadline,
      questionId: answering ? expectedQuestionId : null,
    });
    created = true;
    const resolved = await resolveBaseline({
      app, previousDraftSnapshotId: handle.previousDraftSnapshotId, explicitParentSha, template: input.template,
    });
    const ref = await prepareExecution({
      app, generationId, epoch, baseline: resolved.execution, runtimeRoot: input.runtimeRoot,
    });
    if (resolved.parentVersionSha !== (explicitParentSha ?? null)) {
      await setParentVersion({ appId: app.id, generationId, epoch, parentVersionSha: resolved.parentVersionSha });
    }
    const execution = await createExecution({
      appId: app.id, generationId, epoch, directory: ref.root,
      baselineKind: resolved.baseline.kind,
      baselineSnapshotId: resolved.baseline.snapshotId,
      baselineVersionSha: resolved.baseline.versionSha,
    });
    return {
      generationId, epoch, executionId: execution.id, execution, input: inserted.input, status: 'generating',
      baseline: resolved.baseline, previousDraftSnapshotId: handle.previousDraftSnapshotId, replay: false,
      answeredQuestionId: inserted.answeredQuestionId,
    };
  } catch (error) {
    if (created) {
      await failInitialization({ appId: app.id, generationId, epoch, error });
    } else if (epoch !== null) {
      // 还没建行就把 epoch 交回去：不能留下「active 但没有 generation」的写权限。
      await releaseAuthority({ appId: app.id, epoch }).catch(() => false);
    }
    throw error;
  }
}

/** 幂等回放：原 generation 已有执行就按它的基线描述，不再新建任何东西。 */
async function replayStart(app: WorkspaceApp, inputRecord: InputRecord): Promise<StartGenerationResult> {
  const [executionRow] = await db().select().from(generationExecutions)
    .where(eq(generationExecutions.generationId, inputRecord.generationId));
  const control = await generationControl(inputRecord.generationId);
  const execution = executionRow ? executionView(executionRow) : null;
  return {
    generationId: inputRecord.generationId,
    epoch: execution?.epoch ?? null,
    executionId: execution?.id ?? null,
    execution,
    input: inputRecord,
    status: control?.status ?? 'generating',
    baseline: execution
      ? {
        kind: execution.baselineKind as GenerationBaseline['kind'],
        ...(execution.baselineSnapshotId ? { snapshotId: execution.baselineSnapshotId } : {}),
        ...(execution.baselineVersionSha ? { versionSha: execution.baselineVersionSha } : {}),
      }
      : { kind: 'empty' },
    previousDraftSnapshotId: await getDraft(app.id).catch(() => null),
    replay: true,
    answeredQuestionId: null,
  };
}

// ---------------------------------------------------------------------------------------------------
// 2. 发布：事务部分
// ---------------------------------------------------------------------------------------------------

async function settledWatermarkIn(tx: Transaction, appId: bigint, generationId: string): Promise<number> {
  const rows = await tx.select({ seq: generationInputs.seq, status: generationInputs.status }).from(generationInputs)
    .where(and(eq(generationInputs.appId, appId), eq(generationInputs.generationId, generationId)))
    .orderBy(asc(generationInputs.seq));
  let settled = 0;
  for (const row of rows) {
    if (row.seq !== settled + 1 || row.status !== 'resolved') break;
    settled = row.seq;
  }
  return settled;
}

/** 已发布的事实：重复 publish 幂等返回它，不新增版本、交付或指针版本。 */
async function publishedOutcome(tx: Transaction | null, appId: bigint, generationId: string): Promise<PublishOutcome | null> {
  const run = tx ?? db();
  const [versionRow] = await run.select().from(versionRecords)
    .where(and(eq(versionRecords.appId, appId), eq(versionRecords.generationId, generationId)));
  if (!versionRow) return null;
  const [deliveryRow] = await run.select().from(generationDeliveries)
    .where(and(eq(generationDeliveries.appId, appId), eq(generationDeliveries.versionSha, versionRow.commitSha)));
  if (!deliveryRow) return null;
  const [pointer] = await run.select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, appId));
  return {
    published: true,
    reason: null,
    version: { sha: versionRow.commitSha, title: versionRow.title, changedFiles: [] },
    delivery: { id: deliveryRow.id, directory: deliveryRow.directory },
    revision: pointer?.revision ?? 0,
    alreadyPublished: true,
  };
}

export type PublishGenerationInput = {
  app: WorkspaceApp;
  generationId: string;
  epoch: number;
  /** null 表示本轮没有源码改动：只收束状态与水位，不新增版本、交付或指针版本。 */
  version: PreparedVersion | null;
  /** 已封存的源码快照：登记一行 source_snapshot，交付通过它引用源码（有版本时必填）。 */
  snapshot?: { directory: string; digest: string; parentVersionSha: string | null };
  delivery?: { id: string; directory: string };
  messageId?: string | null;
};

/** 当前 generation 已接受输入的最大 seq；候选必须覆盖到它。 */
async function latestAcceptedSeq(appId: bigint, generationId: string): Promise<number> {
  const [tail] = await db().select({ seq: sql<number>`coalesce(max(${generationInputs.seq}), 0)::int` })
    .from(generationInputs)
    .where(and(eq(generationInputs.appId, appId), eq(generationInputs.generationId, generationId)));
  return Number(tail.seq);
}

/** input_watermark 的候选语义：-1 已作废；正数必须覆盖当前全部已接受输入；0 表示尚未建立候选。 */
function assertCandidateCovers(watermark: number, latestSeq: number): void {
  if (watermark === invalidatedCandidateWatermark) throw new CandidateInvalidatedError();
  if (watermark > 0 && watermark < latestSeq) throw new CandidateInvalidatedError();
}

/**
 * 发布事务：一次校验 owner/终态/deadline/输入水位/父版本，然后原子写入
 * version_record、source_snapshot、generation_delivery、app_preview_pointer、
 * generation(ready/finished)、authority(idle/草稿清空/预览交付) 与 transition。
 *
 * 已发布（status=ready）返回既有事实；已取消/失败则拒绝。取消与发布并发时由事务顺序决定胜负。
 */
export async function publishGeneration(input: PublishGenerationInput): Promise<PublishOutcome> {
  const { app, generationId, epoch } = input;
  const outcome = await db().transaction(async tx => {
    const appRow = await lockAppRow(tx, app.id);
    const authority = await lockAuthorityRow(tx, appRow.id);
    const control = await lockGenerationControl(tx, generationId);
    if (!control) throw new BusinessError(404, 40400, '生成任务不存在');
    if (control.appId !== String(appRow.id)) throw new BusinessError(409, 40900, '生成任务不属于该应用');

    const published = await publishedOutcome(tx, appRow.id, generationId);
    if (published) return published;
    if (control.status === 'ready') {
      // 已按「没有源码改动」收束的生成不能再补一个版本进来。
      if (input.version) throw new BusinessError(409, 40900, '本轮已按没有源码改动收束，不能再发布版本');
      const [pointer] = await tx.select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, appRow.id));
      return {
        published: false, reason: 'no-source-change' as const, version: null, delivery: null,
        revision: pointer?.revision ?? authority.previewRevision, alreadyPublished: true,
      };
    }
    if (!activeStatuses.includes(control.status)) throw new BusinessError(409, 40900, '生成已结束，不能发布');
    if (authority.ownerEpoch !== epoch) throw new BusinessError(409, 40900, '应用写权限已失效');
    if (authority.state !== 'active') throw new BusinessError(409, 40900, '应用不在生成中，不能发布');
    if (control.expired) throw new BusinessError(409, 40900, '生成已超时，不能发布');
    assertCandidateCovers(Number(control.inputWatermark), await latestAcceptedSeq(appRow.id, generationId));

    const [open] = await tx.select({ id: generationInputs.id }).from(generationInputs)
      .where(and(
        eq(generationInputs.appId, appRow.id), eq(generationInputs.generationId, generationId),
        inArray(generationInputs.status, unsettledInputStatuses),
      )).limit(1);
    if (open) throw new BusinessError(409, 40900, '还有未结算的输入，不能发布');

    // 本轮没有源码改动（纯问答、只跑了构建）：正常收束成 ready/finished，
    // 但不动版本、交付与预览指针，也不写 input 之外的任何副作用记录。
    if (!input.version) {
      const [pointer] = await tx.select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, appRow.id));
      const watermark = await settledWatermarkIn(tx, appRow.id, generationId);
      await tx.execute(sql`update generation
        set status = 'ready', phase = 'finished', error = null,
            stop_reason = coalesce(stop_reason, 'no-changes'), input_watermark = ${watermark}, message_id = ${input.messageId ?? null}, update_time = ${now()}
        where id = ${generationId}`);
      await tx.update(appAuthority).set({
        state: 'idle', holder: null, expiresAt: null, draftSnapshotId: null, updateTime: now(),
      }).where(and(eq(appAuthority.appId, appRow.id), eq(appAuthority.ownerEpoch, epoch)));
      await tx.insert(generationTransitions).values({
        appId: appRow.id, generationId, fromState: control.status, toState: 'ready',
        reason: '本轮没有源码改动', createTime: now(),
      });
      return {
        published: false, reason: 'no-source-change' as const, version: null, delivery: null,
        revision: pointer?.revision ?? authority.previewRevision, alreadyPublished: false,
      };
    }

    if (input.version.parent !== control.parentVersionSha) {
      throw new BusinessError(409, 40900, '版本父提交与生成的父版本不一致，不能发布');
    }
    if (!input.snapshot || !input.delivery) throw new BusinessError(409, 40900, '发布缺少源码快照或交付目录');

    const snapshotId = await registerSnapshot({
      tx, appId: appRow.id, generationId, kind: 'version', parentVersionSha: input.version.parent,
      digest: input.snapshot.digest, directory: input.snapshot.directory, message: '发布源码快照',
    });

    const [versionInserted] = await tx.insert(versionRecords).values({
      commitSha: input.version.sha, appId: appRow.id, generationId, title: input.version.title, createTime: now(),
    }).onConflictDoNothing().returning({ commitSha: versionRecords.commitSha });
    const [versionRow] = await tx.select().from(versionRecords)
      .where(and(eq(versionRecords.appId, appRow.id), eq(versionRecords.commitSha, input.version.sha)));
    if (!versionInserted && (!versionRow || versionRow.generationId !== generationId)) {
      throw new BusinessError(409, 40900, '该版本已被其他生成占用，不能发布');
    }
    if (!versionRow) throw new BusinessError(409, 40900, '版本台账写入失败');

    await tx.insert(generationDeliveries).values({
      id: input.delivery.id, appId: appRow.id, generationId, versionSha: input.version.sha,
      sourceSnapshotId: snapshotId, directory: input.delivery.directory, status: 'ready', createTime: now(),
    }).onConflictDoNothing();
    const [deliveryRow] = await tx.select().from(generationDeliveries)
      .where(and(eq(generationDeliveries.appId, appRow.id), eq(generationDeliveries.versionSha, input.version.sha)));
    if (!deliveryRow) throw new BusinessError(409, 40900, '交付登记失败');

    const [pointer] = await tx.insert(appPreviewPointers)
      .values({ appId: appRow.id, deliveryId: deliveryRow.id, revision: 1, updateTime: now() })
      .onConflictDoUpdate({
        target: appPreviewPointers.appId,
        set: {
          deliveryId: deliveryRow.id,
          revision: sql`${appPreviewPointers.revision} + 1`,
          updateTime: now(),
        },
      })
      .returning({ revision: appPreviewPointers.revision });
    const revision = Number(pointer.revision);

    const watermark = await settledWatermarkIn(tx, appRow.id, generationId);
    await tx.execute(sql`update generation
      set status = 'ready', phase = 'finished', error = null,
          stop_reason = coalesce(stop_reason, 'completed'), input_watermark = ${watermark}, message_id = ${input.messageId ?? null}, update_time = ${now()}
      where id = ${generationId}`);
    await tx.update(appAuthority).set({
      state: 'idle', holder: null, expiresAt: null, draftSnapshotId: null,
      previewDeliveryId: deliveryRow.id, previewRevision: revision, updateTime: now(),
    }).where(and(eq(appAuthority.appId, appRow.id), eq(appAuthority.ownerEpoch, epoch)));
    await tx.insert(generationTransitions).values({
      appId: appRow.id, generationId, fromState: control.status, toState: 'ready', reason: '发布完成', createTime: now(),
    });

    return {
      published: true, reason: null,
      version: { sha: versionRow.commitSha, title: versionRow.title, changedFiles: input.version.changedFiles },
      delivery: { id: deliveryRow.id, directory: deliveryRow.directory },
      revision,
      alreadyPublished: false,
    };
  });
  // 提交之后再结算：此时状态对其它连接可见，也不把 credit_account 拉进 app → authority → generation 的锁族。
  await settleGenerationBilling(generationId);
  return outcome;
}

// ---------------------------------------------------------------------------------------------------
// 3. 终态：事务部分（失败/取消）
// ---------------------------------------------------------------------------------------------------

export type SettleGenerationInput = {
  appId: string;
  generationId: string;
  /** 取得写权限时的 epoch；初始化阶段从未取得过（null）时不做 epoch 围栏。 */
  epoch: number | null;
  outcome: 'failed' | 'cancelled';
  error: string;
  stopReason?: GenerationStopReason | null;
  messageId?: string | null;
};

/** 终态事务：已终态不覆盖，返回既有状态；否则写 status/phase/error/stopReason 与 transition。 */
export async function settleGeneration(input: SettleGenerationInput): Promise<{ status: string; alreadyTerminal: boolean }> {
  const result = await db().transaction(async tx => {
    const appRow = await lockAppRow(tx, input.appId);
    const authority = await lockAuthorityRow(tx, appRow.id);
    const control = await lockGenerationControl(tx, input.generationId);
    if (!control) throw new BusinessError(404, 40400, '生成任务不存在');
    if (control.appId !== String(appRow.id)) throw new BusinessError(409, 40900, '生成任务不属于该应用');
    if (!activeStatuses.includes(control.status)) return { status: control.status, alreadyTerminal: true };
    if (input.epoch !== null && authority.ownerEpoch !== input.epoch) throw new BusinessError(409, 40900, '应用写权限已失效');
    const status = input.outcome === 'cancelled' ? 'cancelled' : 'failed';
    const stopReason = input.outcome === 'cancelled'
      ? (input.stopReason ?? 'cancelled')
      : (input.stopReason ?? null);
    await tx.execute(sql`update generation
      set status = ${status}, phase = 'finished', error = ${input.error}, stop_reason = ${stopReason}, message_id = ${input.messageId ?? null}, update_time = ${now()}
      where id = ${input.generationId} and status in ('generating', 'building')`);
    await tx.insert(generationTransitions).values({
      appId: appRow.id, generationId: input.generationId, fromState: control.status, toState: status,
      reason: input.error, createTime: now(),
    });
    return { status, alreadyTerminal: false };
  });
  // 已终态的重复通知也要走一遍：进程崩在「终态已提交、结算未执行」时，靠这次重放补账；
  // 真已结算过的由 credit_charge.generation_id 唯一键挡下，不会重复扣费。
  await settleGenerationBilling(input.generationId);
  return result;
}

/** 阶段是内部控制面事实：只允许当前 epoch 的 active owner 推进，避免旧进程把阶段改错。 */
async function markPhase(appId: string, generationId: string, epoch: number, phase: 'checking' | 'publishing'): Promise<void> {
  await db().execute(sql`update generation set phase = ${phase}, update_time = ${now()}
    where id = ${generationId} and status in ('generating', 'building')
      and exists (select 1 from app_authority a
        where a.app_id = ${appKey(appId)} and a.owner_epoch = ${epoch} and a.state = 'active')`);
}

// ---------------------------------------------------------------------------------------------------
// 2b/3b. 文件事务：封存、Git、交付、预览指针
// ---------------------------------------------------------------------------------------------------

/** 复制一份「可交付」的源码树：跳过平台清单/元数据，拒绝符号链接与特殊文件。 */
async function copyDeliverySource(source: string, target: string, depth = 0): Promise<void> {
  if (depth > maxDeliverySourceDepth) throw new Error('交付源码目录过深');
  for (const entry of await readdir(source, { withFileTypes: true })) {
    // 交付根的快照清单是平台元数据；嵌套的 manifest.json 是应用源码。
    if (deliverySourcePlatformSkipped.test(entry.name) || (depth === 0 && entry.name === 'manifest.json')) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error('交付源码不能包含符号链接');
    if (info.isDirectory()) {
      await mkdir(to);
      await copyDeliverySource(from, to, depth + 1);
      continue;
    }
    if (!info.isFile()) throw new Error('交付源码只能包含普通文件和目录');
    await copyFile(from, to);
  }
}

/**
 * 交付源码目录：
 * - 调用方给了 buildDirectory 就用它（工程类型一般是 <exec>/dist）；
 * - 工程类型默认 <exec>/dist；
 * - 静态类型默认由封存快照派生一份临时目录：快照根有平台 manifest.json，交付目录不允许它。
 */
async function stageDeliverySource(input: {
  app: WorkspaceApp;
  executionDirectory: string;
  snapshot: { directory: string };
  buildDirectory?: string;
  runtimeRoot?: string;
}): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  if (input.buildDirectory) return { directory: input.buildDirectory, cleanup: async () => undefined };
  if (isProjectCodeGenType(input.app.codeGenType)) {
    return { directory: join(input.executionDirectory, 'dist'), cleanup: async () => undefined };
  }
  const runtime = await ensureSafeDirectory(resolve(input.runtimeRoot ?? getConfig().runtimeRoot));
  const temporary = await ensureSafeDirectory(join(runtime, 'tmp'));
  const staged = await mkdtemp(join(temporary, 'delivery-source-'));
  await copyDeliverySource(input.snapshot.directory, staged);
  return { directory: staged, cleanup: () => rm(staged, { recursive: true, force: true }) };
}

/** 文件指针是数据库 `app_preview_pointer` 的派生：失败只记日志，由 recover 补写。 */
async function syncPreview(input: { app: WorkspaceApp; deliveryId: string; runtimeRoot?: string }): Promise<boolean> {
  try {
    await setCurrentDelivery({ app: input.app, deliveryId: input.deliveryId, runtimeRoot: input.runtimeRoot });
    return true;
  } catch (error) {
    console.error(`预览指针写入失败（应用 ${input.app.id}）：`, error);
    return false;
  }
}

/**
 * 发布失败（封存/Git/交付/事务）后的补偿：要么把 generation 明确收束成 failed 并留下草稿，
 * 要么把写权限留在 draining 交给恢复。任何情况下都不把 authority 停在 active。
 */
async function compensatePublishFailure(input: {
  app: WorkspaceApp;
  generationId: string;
  epoch: number;
  execution: { id: string; directory: string };
  error: unknown;
  runtimeRoot?: string;
  snapshotsRoot?: string;
  drainTimeoutMs?: number;
}): Promise<void> {
  const control = await generationControl(input.generationId);
  // 已经终态（例如取消/发布先提交）就不动它。
  if (!control || !activeStatuses.includes(control.status)) return;
  await failOrCancel({
    app: input.app, generationId: input.generationId, epoch: input.epoch, execution: input.execution,
    outcome: 'failed', error: `发布失败：${messageOf(input.error)}`, stopReason: 'verification-failed',
    runtimeRoot: input.runtimeRoot, snapshotsRoot: input.snapshotsRoot, drainTimeoutMs: input.drainTimeoutMs,
  });
}

export async function publishReady(input: PublishReadyInput): Promise<PublishReadyResult> {
  const { app, generationId, epoch } = input;
  let control = await generationControl(generationId);
  if (!control) throw new BusinessError(404, 40400, '生成任务不存在');
  if (control.appId !== app.id) throw new BusinessError(409, 40900, '生成任务不属于该应用');
  if (!activeStatuses.includes(control.status)) {
    // 已发布的重放：返回既有事实，不重新封存/提交/建交付；已取消/失败则明确拒绝。
    const published = await publishedOutcome(null, appKey(app.id), generationId);
    if (published) {
      return {
        ...published,
        previewSynced: published.delivery
          ? await syncPreview({ app, deliveryId: published.delivery.id, runtimeRoot: input.runtimeRoot })
          : true,
      };
    }
    if (control.status === 'ready') {
      // 这一轮是按「没有源码改动」收束的：重放依然没有版本与交付。
      const [pointer] = await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, appKey(app.id)));
      return {
        published: false, reason: 'no-source-change', version: null, delivery: null,
        revision: pointer?.revision ?? 0, alreadyPublished: true, previewSynced: true,
      };
    }
    throw new BusinessError(409, 40900, '生成已结束，不能发布');
  }

  const ref: ExecutionRef = { root: input.execution.directory, generationId, epoch };
  let createdDelivery: { id: string; directory: string } | null = null;
  let sealedDirectory: string | null = null;
  try {
    // 前置校验不产生任何副作用：调用方结算输入或换父版本后可以直接重试。
    if (control.expired) throw new BusinessError(409, 40900, '生成已超时，不能发布');
    const [openInput] = await db().select({ id: generationInputs.id }).from(generationInputs)
      .where(and(
        eq(generationInputs.appId, appKey(app.id)), eq(generationInputs.generationId, generationId),
        inArray(generationInputs.status, unsettledInputStatuses),
      )).limit(1);
    if (openInput) throw new CandidateInvalidatedError('还有未结算的输入，旧发布候选已失效');
    // 候选从平台验收开始时建立。直接调用发布（例如测试或旧接口）没有建立候选时补一次；
    // 已经被新输入标成 -1 的候选必须拒绝，不能靠补建候选绕过失效。
    if (control.inputWatermark === invalidatedCandidateWatermark) throw new CandidateInvalidatedError();
    if (control.phase === 'editing') {
      await beginChecking({ appId: app.id, generationId, epoch });
      control = (await generationControl(generationId)) ?? control;
    } else {
      assertCandidateCovers(control.inputWatermark, await latestAcceptedSeq(appKey(app.id), generationId));
    }
    const parentSha = input.parentVersionSha === undefined ? control.parentVersionSha : normaliseSha(input.parentVersionSha);
    if (input.parentVersionSha !== undefined && parentSha !== control.parentVersionSha) {
      throw new BusinessError(409, 40900, '父版本与生成记录的父版本不一致，不能发布');
    }

    await markPhase(app.id, generationId, epoch, 'publishing');
    await closeExecutionAndDrain(ref, input.drainTimeoutMs ?? defaultDrainTimeoutMs);
    const sealed = await sealSource({ app, ref, snapshotsRoot: input.snapshotsRoot });
    sealedDirectory = sealed.directory;
    // 封存一结束就登记源码快照：之后的发布事务失败、或转成取消，都能复用这份快照，
    // 不会因为「快照目录已存在」卡在 draining 里。
    await registerSnapshot({
      appId: appKey(app.id), generationId, kind: 'version', parentVersionSha: control.parentVersionSha,
      digest: sealed.digest, directory: sealed.directory, message: '发布源码快照',
    });

    // 封存快照根有自己的 manifest.json：它描述快照，不是源码，不进版本树。
    // headFallback:false —— 父版本必须是生成记录下来的那一版，null 就是无父提交。
    const prepared = await prepareVersionCommit({
      app, workTree: sealed.directory, title: input.title, parentSha,
      excludePaths: ['manifest.json'], headFallback: false,
    });
    if (!prepared) {
      // 纯问答/只有构建：没有可版本化的源码改动，仍然正常收束，预览指针保持不变。
      const outcome = await publishGeneration({ app, generationId, epoch, version: null, messageId: input.messageId });
      await sealExecutionRecord(input.execution.id);
      return { ...outcome, previewSynced: true };
    }

    const staged = await stageDeliverySource({
      app, executionDirectory: ref.root, snapshot: sealed, buildDirectory: input.buildDirectory, runtimeRoot: input.runtimeRoot,
    });
    let delivery: { id: string; directory: string };
    try {
      delivery = await createDelivery({
        app, generationId, versionSha: prepared.sha, sourceDir: staged.directory, runtimeRoot: input.runtimeRoot,
      });
    } finally {
      await staged.cleanup();
    }
    createdDelivery = delivery;

    const published = await publishGeneration({
      app, generationId, epoch, version: prepared,
      snapshot: { directory: sealed.directory, digest: sealed.digest, parentVersionSha: prepared.parent },
      delivery: { id: delivery.id, directory: delivery.directory },
      messageId: input.messageId,
    });
    await sealExecutionRecord(input.execution.id);
    if (published.published && published.version) {
      await syncVersionWorkspace({ app, versionId: published.version.sha })
        .catch(error => console.warn(`版本工作区镜像失败（应用 ${app.id}）：`, error));
    }
    return {
      ...published,
      previewSynced: published.delivery
        ? await syncPreview({ app, deliveryId: published.delivery.id, runtimeRoot: input.runtimeRoot })
        : true,
    };
  } catch (error) {
    // 新输入作废旧候选不是失败：把控制权交回观察者继续 editing，不封存成失败草稿。
    if (error instanceof CandidateInvalidatedError) {
      // 失效通知可能晚于取消/提问收束：这时 generation 已经终态，执行和草稿也可能已经
      // 被 cancel/ask 封存并登记。重新打开/删除会把已提交的交接弄坏，只做无主清理。
      const current = await generationControl(generationId);
      const [authority] = await db().select({ ownerEpoch: appAuthority.ownerEpoch, state: appAuthority.state })
        .from(appAuthority).where(eq(appAuthority.appId, appKey(app.id)));
      const owns = authority?.ownerEpoch === epoch && (authority.state === 'active' || authority.state === 'draining');
      if (!current || !activeStatuses.includes(current.status) || !owns) {
        if (createdDelivery) await rm(createdDelivery.directory, { recursive: true, force: true }).catch(() => undefined);
        if (sealedDirectory) {
          const references = await db().select({ kind: sourceSnapshots.kind }).from(sourceSnapshots).where(and(
            eq(sourceSnapshots.appId, appKey(app.id)), eq(sourceSnapshots.directory, sealedDirectory),
          )).catch(() => []);
          await db().delete(sourceSnapshots).where(and(
            eq(sourceSnapshots.appId, appKey(app.id)), eq(sourceSnapshots.generationId, generationId),
            eq(sourceSnapshots.directory, sealedDirectory), eq(sourceSnapshots.kind, 'version'),
          )).catch(problem => console.warn(`清理失效发布快照记录失败（生成 ${generationId}）：`, problem));
          if (!references.some(row => row.kind !== 'version')) {
            await rm(sealedDirectory, { recursive: true, force: true }).catch(() => undefined);
          }
        }
        throw error;
      }
      // 执行可能已停在 draining/sealed；先恢复成 active，观察者才能继续消费新输入。
      await reopenExecution(input.execution.id).catch(problem => console.warn(`恢复编辑执行失败（生成 ${generationId}）：`, problem));
      await openExecution(ref).catch(problem => console.warn(`重新打开执行写门失败（生成 ${generationId}）：`, problem));
      await db().execute(sql`update generation set phase = 'editing', update_time = ${now()}
        where id = ${generationId} and status in ('generating', 'building')`).catch(() => undefined);
      if (createdDelivery) await rm(createdDelivery.directory, { recursive: true, force: true }).catch(() => undefined);
      // 这份快照对应的是「新输入之前」的源码；下一次发布必须重新封存，不能复用它。
      if (sealedDirectory) {
        const references = await db().select({ kind: sourceSnapshots.kind }).from(sourceSnapshots).where(and(
          eq(sourceSnapshots.appId, appKey(app.id)), eq(sourceSnapshots.directory, sealedDirectory),
        )).catch(() => []);
        await db().delete(sourceSnapshots).where(and(
          eq(sourceSnapshots.appId, appKey(app.id)), eq(sourceSnapshots.generationId, generationId),
          eq(sourceSnapshots.directory, sealedDirectory), eq(sourceSnapshots.kind, 'version'),
        )).catch(problem => console.warn(`清理失效发布快照记录失败（生成 ${generationId}）：`, problem));
        if (!references.some(row => row.kind !== 'version')) {
          await rm(sealedDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      throw error;
    }
    await compensatePublishFailure({
      app, generationId, epoch, execution: input.execution, error,
      runtimeRoot: input.runtimeRoot, snapshotsRoot: input.snapshotsRoot, drainTimeoutMs: input.drainTimeoutMs,
    }).catch(compensationError => {
      // 补偿也没救回来：写权限留在 draining，交给 recover；原始错误照常抛给调用方。
      console.error(`发布失败后的补偿未完成（生成 ${generationId}）：`, compensationError);
    });
    throw error;
  }
}

export async function failOrCancel(input: FailOrCancelInput): Promise<FailOrCancelResult> {
  const { app, generationId, epoch } = input;
  const control = await generationControl(generationId);
  if (!control) throw new BusinessError(404, 40400, '生成任务不存在');
  if (control.appId !== app.id) throw new BusinessError(409, 40900, '生成任务不属于该应用');
  // 已发布/已终态：不覆盖，也不再去封存别人已经封存过的目录；只补一个空的 messageId 供 UI 定位助手气泡。
  if (!activeStatuses.includes(control.status)) {
    if (input.messageId) {
      await db().update(generations).set({ messageId: input.messageId })
        .where(and(eq(generations.id, generationId), isNull(generations.messageId)));
    }
    return { draftSnapshotId: null, alreadyTerminal: true, status: control.status };
  }

  try {
    await beginDrain({ appId: app.id, epoch, generationId, reason: input.outcome === 'cancelled' ? '用户取消' : '生成失败' });
    await markInputUnanswered({ appId: app.id, generationId });
    await closeQuestion({ appId: app.id, generationId });

    const ref: ExecutionRef = { root: input.execution.directory, generationId, epoch };
    let draftSnapshotId: string | null = null;
    if (await directoryExists(ref.root)) {
      await closeExecutionAndDrain(ref, input.drainTimeoutMs ?? defaultDrainTimeoutMs);
      // 封存失败必须抛出去：authority 留在 draining，下一轮 start 返回交接中，绝不静默回退到旧版本。
      const sealed = await sealSource({ app, ref, snapshotsRoot: input.snapshotsRoot });
      draftSnapshotId = await ensureDraftSnapshot({
        appId: appKey(app.id), generationId, parentVersionSha: control.parentVersionSha,
        sealed, message: '失败/取消封存草稿',
      });
      await sealExecutionRecord(input.execution.id);
    } else {
      await setExecutionStatus(input.execution.id, 'failed');
    }

    await finishDrain({ appId: app.id, epoch, draftSnapshotId });
    const settled = await settleGeneration({
      appId: app.id, generationId, epoch, outcome: input.outcome, error: input.error, stopReason: input.stopReason,
      // 失败/取消也要把助手气泡 id 落库：账单与用量块都靠它挂到那一条回复下。
      messageId: input.messageId ?? null,
    });
    return { draftSnapshotId, alreadyTerminal: settled.alreadyTerminal, status: settled.status };
  } catch (error) {
    // 已经决定收束却中途失败：至少把新 effect 的入口关掉，不要把写权限停在 active。
    await beginDrain({ appId: app.id, epoch, generationId, reason: '交接失败，等待恢复' }).catch(() => false);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------
// 3b. 等待回答：封存草稿但保留提问
// ---------------------------------------------------------------------------------------------------

/**
 * ask 之后的收束：与失败/取消同一条交接协议（撤 epoch、停写入、封存草稿、回 idle），
 * 但**保留开放提问**——问题还在等回答，回答会开启下一轮 generation（基线优先承接这份草稿）。
 *
 * 公开状态仍是 failed（不新增 generation status），由 stopReason='question' 表明这不是失败终态；
 * 封存失败时 authority 留在 draining 并抛错，与 failOrCancel 一致，绝不静默回退到旧版本。
 */
export async function pauseForQuestion(input: PauseForQuestionInput): Promise<PauseForQuestionResult> {
  const { app, generationId, epoch } = input;
  const control = await generationControl(generationId);
  if (!control) throw new BusinessError(404, 40400, '生成任务不存在');
  if (control.appId !== app.id) throw new BusinessError(409, 40900, '生成任务不属于该应用');
  if (!activeStatuses.includes(control.status)) {
    if (input.messageId) {
      await db().update(generations).set({ messageId: input.messageId })
        .where(and(eq(generations.id, generationId), isNull(generations.messageId)));
    }
    return { draftSnapshotId: null, alreadyTerminal: true, status: control.status };
  }

  try {
    await beginDrain({ appId: app.id, epoch, generationId, reason: '提问后等待回答' });
    // 只把还没结算的输入标 unanswered：start 输入已经在收尾前 resolved，不跟着一起翻。
    await markInputUnanswered({ appId: app.id, generationId });

    const ref: ExecutionRef = { root: input.execution.directory, generationId, epoch };
    let draftSnapshotId: string | null = null;
    if (await directoryExists(ref.root)) {
      await closeExecutionAndDrain(ref, input.drainTimeoutMs ?? defaultDrainTimeoutMs);
      const sealed = await sealSource({ app, ref, snapshotsRoot: input.snapshotsRoot });
      draftSnapshotId = await ensureDraftSnapshot({
        appId: appKey(app.id), generationId, parentVersionSha: control.parentVersionSha,
        sealed, message: '等待回答时封存草稿',
      });
      await sealExecutionRecord(input.execution.id);
    } else {
      await setExecutionStatus(input.execution.id, 'failed');
    }

    await finishDrain({ appId: app.id, epoch, draftSnapshotId });
    // 不 closeQuestion：提问要继续等回答，回答时在 startGeneration 的事务里被消费。
    const settled = await settleGeneration({
      appId: app.id, generationId, epoch, outcome: 'failed', error: '等待用户回答',
      stopReason: 'question', messageId: input.messageId ?? null,
    });
    return { draftSnapshotId, alreadyTerminal: settled.alreadyTerminal, status: settled.status };
  } catch (error) {
    // 已经决定收束却中途失败：至少把新 effect 的入口关掉，不要把写权限停在 active。
    await beginDrain({ appId: app.id, epoch, generationId, reason: '提问交接失败，等待恢复' }).catch(() => false);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------
// 4. 恢复对账
// ---------------------------------------------------------------------------------------------------

type AuthoritySnapshot = {
  epoch: number; state: AuthorityState; holder: string | null; draftSnapshotId: string | null;
  previewDeliveryId: string | null; live: boolean; expired: boolean;
};

/** authority 视图：live/expired 都由数据库时钟算，scan 与判断使用同一份快照。 */
async function readAuthoritySnapshot(appId: bigint): Promise<AuthoritySnapshot | null> {
  const [row] = await db().select({
    epoch: appAuthority.ownerEpoch,
    state: appAuthority.state,
    holder: appAuthority.holder,
    draftSnapshotId: appAuthority.draftSnapshotId,
    previewDeliveryId: appAuthority.previewDeliveryId,
    live: sql<boolean>`(${appAuthority.state} = 'active' and ${appAuthority.expiresAt} is not null and ${appAuthority.expiresAt} > timezone('UTC', now()))`,
    expired: sql<boolean>`(${appAuthority.state} in ('active', 'draining') and (${appAuthority.expiresAt} is null or ${appAuthority.expiresAt} <= timezone('UTC', now())))`,
  }).from(appAuthority).where(eq(appAuthority.appId, appId));
  return row ?? null;
}

/** 收束 authority：draining 结束、过期 active 先撤 epoch，最后把草稿引用落下。 */
async function closeAuthority(input: {
  appId: string;
  authority: AuthoritySnapshot;
  generationId: string | null;
  draftSnapshotId: string | null;
  errors: string[];
}): Promise<string> {
  const { appId, authority, generationId, draftSnapshotId, errors } = input;
  if (authority.state === 'idle') {
    if (draftSnapshotId) await setDraft({ appId, snapshotId: draftSnapshotId }).catch(error => { errors.push(messageOf(error)); });
    return 'already-idle';
  }
  if (authority.state === 'active' && generationId) {
    await beginDrain({ appId, epoch: authority.epoch, generationId, reason: '恢复回收过期写权限' })
      .catch(error => { errors.push(messageOf(error)); });
  }
  const finished = await finishDrain({ appId, epoch: authority.epoch, draftSnapshotId })
    .catch(error => { errors.push(messageOf(error)); return false; });
  if (finished) return 'drained';
  // 撤 epoch 失败或 epoch 已被别人接管：只清 holder，不碰别人的新 epoch。
  const released = await releaseAuthority({ appId, epoch: authority.epoch }).catch(error => { errors.push(messageOf(error)); return false; });
  if (draftSnapshotId) await setDraft({ appId, snapshotId: draftSnapshotId }).catch(error => { errors.push(messageOf(error)); });
  return released ? 'released' : 'lost';
}

async function recoverOneGeneration(input: {
  app: WorkspaceApp;
  control: GenerationControl;
  snapshotsRoot?: string;
  drainTimeoutMs?: number;
}): Promise<RecoveredGeneration> {
  const { app, control } = input;
  const errors: string[] = [];
  let draftSnapshotId: string | null = null;
  let sealed = false;
  const [executionRow] = await db().select().from(generationExecutions)
    .where(eq(generationExecutions.generationId, control.id));

  if (executionRow) {
    const ref: ExecutionRef = { root: executionRow.directory, generationId: control.id, epoch: executionRow.epoch };
    if (await directoryExists(ref.root)) {
      try {
        await closeExecutionAndDrain(ref, input.drainTimeoutMs ?? 5_000);
        const sealedSource = await sealSource({ app, ref, snapshotsRoot: input.snapshotsRoot });
        draftSnapshotId = await ensureDraftSnapshot({
          appId: appKey(app.id), generationId: control.id, parentVersionSha: control.parentVersionSha,
          sealed: sealedSource, message: '恢复时封存草稿',
        });
        sealed = true;
      } catch (error) {
        // 上一次封存已经落地、只是没登记完：复用那份快照，不重复封存。
        const existing = await registeredSnapshot(appKey(app.id), control.id).catch(() => null);
        if (existing && await directoryExists(existing.directory)) {
          draftSnapshotId = existing.id;
          sealed = true;
        } else {
          errors.push(messageOf(error));
        }
      }
    }
    if (sealed) await sealExecutionRecord(executionRow.id);
    else await setExecutionStatus(executionRow.id, 'failed');
  }

  await settleGeneration({
    appId: app.id, generationId: control.id, epoch: null,
    outcome: 'failed', error: '生成进程中断，草稿已保留', stopReason: 'interrupted',
  }).catch(error => {
    // 生成已被接管或已经不活跃：记下来，不猜它应该是什么状态。
    errors.push(messageOf(error));
  });

  return {
    generationId: control.id, status: 'failed', draftSnapshotId, executionId: executionRow?.id ?? null, sealed, errors,
  };
}

export async function recoverGeneration(input: {
  app: WorkspaceApp;
  runtimeRoot?: string;
  snapshotsRoot?: string;
  drainTimeoutMs?: number;
  holder?: string;
}): Promise<RecoverySummary> {
  const { app } = input;
  const appId = appKey(app.id);
  const errors: string[] = [];
  const authority = await readAuthoritySnapshot(appId);
  const activeGenerationIds = (await db().select({ id: generations.id }).from(generations)
    .where(and(eq(generations.appId, appId), inArray(generations.status, activeStatuses))))
    .map(row => row.id);
  const controls = (await Promise.all(activeGenerationIds.map(id => generationControl(id))))
    .filter((row): row is GenerationControl => row !== null);

  const recovered: RecoveredGeneration[] = [];
  const pending: PendingReconciliation[] = [];
  let action = 'none';

  // 有活着的 owner 就什么都不动：它的 generation 由它自己推进（pending 仍然上报给调用方对账）。
  if (!authority?.live) {
    for (const control of controls) {
      if (control.phase === 'checking' || control.phase === 'publishing') {
        pending.push({ generationId: control.id, status: control.status, phase: control.phase });
        continue;
      }
      recovered.push(await recoverOneGeneration({ app, control, snapshotsRoot: input.snapshotsRoot, drainTimeoutMs: input.drainTimeoutMs }));
    }
    if (authority) {
      action = await closeAuthority({
        appId: app.id, authority,
        generationId: recovered.at(-1)?.generationId ?? controls.at(-1)?.id ?? null,
        draftSnapshotId: recovered.find(item => item.draftSnapshotId)?.draftSnapshotId ?? null,
        errors,
      });
    } else if (!controls.length) {
      action = 'no-authority';
    }
  }

  // 预览文件指针是数据库指针的派生：落后或丢失时补写一次。
  let previewRepaired = false;
  const [dbPointer] = await db().select().from(appPreviewPointers).where(eq(appPreviewPointers.appId, appId));
  const targetDeliveryId = authority?.previewDeliveryId ?? dbPointer?.deliveryId ?? null;
  if (targetDeliveryId) {
    const current = await currentDelivery({ app, runtimeRoot: input.runtimeRoot }).catch(error => {
      errors.push(messageOf(error));
      return null;
    });
    if (current?.deliveryId !== targetDeliveryId) {
      previewRepaired = await syncPreview({ app, deliveryId: targetDeliveryId, runtimeRoot: input.runtimeRoot });
      if (!previewRepaired) errors.push('预览指针补写失败');
    }
  }

  return {
    appId: app.id,
    authority: authority ? { epoch: authority.epoch, state: authority.state, expired: authority.expired, action } : null,
    recovered,
    pending,
    previewRepaired,
    errors: [...errors, ...recovered.flatMap(item => item.errors)],
  };
}

async function recoverApps(input: {
  holder: string;
  runtimeRoot?: string;
  snapshotsRoot?: string;
  appIds: bigint[];
}): Promise<RecoverySummary[]> {
  const summaries: RecoverySummary[] = [];
  for (const appId of input.appIds) {
    const [row] = await db().select({ id: apps.id, codeGenType: apps.codeGenType }).from(apps)
      .where(and(eq(apps.id, appId), eq(apps.isDelete, 0)));
    if (!row) continue;
    const app: WorkspaceApp = { id: String(row.id), codeGenType: row.codeGenType as WorkspaceApp['codeGenType'] };
    try {
      summaries.push(await recoverGeneration({
        app, runtimeRoot: input.runtimeRoot, snapshotsRoot: input.snapshotsRoot, holder: input.holder,
      }));
    } catch (error) {
      summaries.push({
        appId: app.id, authority: null, recovered: [], pending: [], previewRepaired: false, errors: [messageOf(error)],
      });
    }
  }
  return summaries;
}

/** 扫描过期（active/draining 且 expires_at 已过）的 authority，逐个应用回收并封存草稿。 */
export async function recoverExpiredAuthority(input: {
  holder: string;
  runtimeRoot?: string;
  snapshotsRoot?: string;
}): Promise<RecoverySummary[]> {
  const holder = requiredText(input.holder, '缺少持有者标识', 200);
  const expired = await db().select({ appId: appAuthority.appId }).from(appAuthority)
    .where(and(
      inArray(appAuthority.state, ['active', 'draining']),
      sql`${appAuthority.expiresAt} is not null and ${appAuthority.expiresAt} <= timezone('UTC', now())`,
    ));
  return recoverApps({ holder, runtimeRoot: input.runtimeRoot, snapshotsRoot: input.snapshotsRoot, appIds: expired.map(row => row.appId) });
}

/**
 * 启动恢复：扫描所有带 authority 或有未收束执行的应用。
 * editing 收束成 failed/interrupted 并封存草稿；checking/publishing 只作为待对账上报。
 */
export async function recoverStartup(input: {
  holder: string;
  runtimeRoot?: string;
  snapshotsRoot?: string;
}): Promise<RecoveryStartupSummary> {
  const holder = requiredText(input.holder, '缺少持有者标识', 200);
  const authorityApps = await db().select({ appId: appAuthority.appId }).from(appAuthority);
  const executionApps = await db().selectDistinct({ appId: generationExecutions.appId }).from(generationExecutions)
    .where(inArray(generationExecutions.status, ['preparing', 'active', 'draining']));
  // 准入事务已经提交、却还没拿到 authority 的 generation 也要扫到，否则它会永远停在 generating。
  const generationApps = await db().selectDistinct({ appId: generations.appId }).from(generations)
    .where(inArray(generations.status, activeStatuses));
  const appIds = [...new Set([...authorityApps, ...executionApps, ...generationApps].map(row => String(row.appId)))].map(BigInt);
  const summaries = await recoverApps({ holder, runtimeRoot: input.runtimeRoot, snapshotsRoot: input.snapshotsRoot, appIds });
  return {
    holder,
    apps: summaries.length,
    recovered: summaries.reduce((count, summary) => count + summary.recovered.length, 0),
    pending: summaries.reduce((count, summary) => count + summary.pending.length, 0),
    errors: summaries.flatMap(summary => summary.errors),
    summaries,
  };
}

// ---------------------------------------------------------------------------------------------------
// 5. 只读辅助（UI / 恢复对账需要，不推进任何状态）
// ---------------------------------------------------------------------------------------------------

export async function getInputs(input: { appId: string; generationId: string }): Promise<GenerationInputView[]> {
  const rows = await db().select().from(generationInputs)
    .where(and(eq(generationInputs.appId, appKey(input.appId)), eq(generationInputs.generationId, input.generationId)))
    .orderBy(asc(generationInputs.seq));
  return rows.map(row => ({ ...inputView(row) }));
}

/** 每 app 最多一个开放提问；按状态查时取最新一条。 */
export async function findQuestion(input: {
  appId: string;
  generationId?: string;
  status?: 'open' | 'answered' | 'cancelled';
}): Promise<QuestionRecord | null> {
  const [row] = await db().select().from(generationQuestions)
    .where(and(
      eq(generationQuestions.appId, appKey(input.appId)),
      ...(input.generationId ? [eq(generationQuestions.generationId, input.generationId)] : []),
      ...(input.status ? [eq(generationQuestions.status, input.status)] : []),
    ))
    .orderBy(asc(generationQuestions.createTime))
    .limit(1);
  return row ? questionView(row) : null;
}

export type { ExecutionBaseline, ExecutionRef };
