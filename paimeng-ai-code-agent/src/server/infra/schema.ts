import { sql } from 'drizzle-orm';
import { bigint, bigserial, char, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

const times = { createTime: timestamp('create_time', { mode: 'string' }).notNull(), updateTime: timestamp('update_time', { mode: 'string' }).notNull() };
export const users = pgTable('app_user', { id: bigint('id', { mode: 'bigint' }).primaryKey(), userAccount: varchar('user_account', { length: 256 }).notNull(), userPassword: varchar('user_password', { length: 512 }).notNull(), userName: varchar('user_name', { length: 256 }), userAvatar: varchar('user_avatar', { length: 1024 }), userProfile: varchar('user_profile', { length: 512 }), userRole: varchar('user_role', { length: 256 }).notNull().default('user'), ...times, isDelete: integer('is_delete').notNull().default(0) }, t => [uniqueIndex('uk_app_user_account').on(t.userAccount)]);
export const apps = pgTable('app', { id: bigint('id', { mode: 'bigint' }).primaryKey(), appName: varchar('app_name', { length: 256 }), cover: varchar('cover', { length: 512 }), initPrompt: text('init_prompt').notNull(), codeGenType: varchar('code_gen_type', { length: 64 }).notNull(), deployKey: varchar('deploy_key', { length: 64 }), deployedTime: timestamp('deployed_time', { mode: 'string' }), editTime: timestamp('edit_time', { mode: 'string', precision: 3 }), priority: integer('priority').notNull().default(0), userId: bigint('user_id', { mode: 'bigint' }).notNull(), conversationId: bigint('conversation_id', { mode: 'number' }), ...times, isDelete: integer('is_delete').notNull().default(0) }, t => [uniqueIndex('uk_app_deploy_key').on(t.deployKey), index('idx_app_user').on(t.userId)]);
export const snowflakeState = pgTable('id_sequence', { nodeId: smallint('node_id').primaryKey(), lastId: bigint('last_id', { mode: 'bigint' }).notNull() });
export const sessions = pgTable('user_session', { tokenHash: varchar('token_hash', { length: 64 }).primaryKey(), userId: bigint('user_id', { mode: 'bigint' }).notNull(), expiresAt: timestamp('expires_at', { mode: 'string', precision: 3 }).notNull() }, t => [index('idx_user_session_expiry').on(t.expiresAt)]);
export const generations = pgTable('generation', { id: varchar('id', { length: 36 }).primaryKey(), appId: bigint('app_id', { mode: 'bigint' }).notNull(), userId: bigint('user_id', { mode: 'bigint' }).notNull(), status: varchar('status', { length: 32 }).notNull(), error: text('error'), stopReason: varchar('stop_reason', { length: 32 }), messageId: varchar('message_id', { length: 64 }), ...times }, t => [index('idx_generation_app').on(t.appId, t.createTime)]);
// 版本台账（docs/plans/archive/version-ledger.md）：清单只认这张表，Git 只当内容库。
// 文件统计与改动清单不入表，由 version-store 按 commit_sha 现算，两个源头永不对账。
export const versionRecords = pgTable('version_record', { commitSha: char('commit_sha', { length: 40 }).notNull(), appId: bigint('app_id', { mode: 'bigint' }).notNull().references(() => apps.id, { onDelete: 'cascade' }), generationId: varchar('generation_id', { length: 36 }).references(() => generations.id, { onDelete: 'set null' }), title: text('title').notNull(), createTime: timestamp('create_time', { mode: 'string', precision: 3 }).notNull() }, t => [primaryKey({ columns: [t.appId, t.commitSha] }), index('idx_version_record_app_time').on(t.appId, t.createTime), uniqueIndex('uk_version_record_generation').on(t.generationId)]);
// 生成任务的逐步记账（D2）：kind 为 model / summary / build。token 为 NULL 表示上游未返回用量。
export const generationSteps = pgTable('generation_step', { id: bigserial('id', { mode: 'bigint' }).primaryKey(), generationId: varchar('generation_id', { length: 36 }).notNull().references(() => generations.id, { onDelete: 'cascade' }), kind: varchar('kind', { length: 16 }).notNull(), round: integer('round').notNull(), stepNumber: integer('step_number').notNull(), modelAlias: varchar('model_alias', { length: 64 }), providerId: varchar('provider_id', { length: 64 }), modelName: varchar('model_name', { length: 256 }), upstreamProvider: varchar('upstream_provider', { length: 64 }), upstreamModelId: varchar('upstream_model_id', { length: 256 }), durationMs: integer('duration_ms'), modelMs: integer('model_ms'), toolMs: integer('tool_ms'), inputTokens: integer('input_tokens'), outputTokens: integer('output_tokens'), cacheReadTokens: integer('cache_read_tokens'), cacheWriteTokens: integer('cache_write_tokens'), reasoningTokens: integer('reasoning_tokens'), finishReason: varchar('finish_reason', { length: 32 }), status: varchar('status', { length: 16 }).notNull(), stage: varchar('stage', { length: 32 }), repairable: integer('repairable'), toolCalls: jsonb('tool_calls').$type<{ name: string; ok: boolean; ms: number | null }[]>(), detail: text('detail'), createTime: timestamp('create_time', { mode: 'string', precision: 3 }).notNull() }, t => [index('idx_generation_step_generation').on(t.generationId)]);
export const leases = pgTable('generation_lease', { appId: bigint('app_id', { mode: 'bigint' }).primaryKey(), generationId: varchar('generation_id', { length: 36 }).notNull(), expiresAt: timestamp('expires_at', { mode: 'string', precision: 3 }).notNull() });
// 用户随消息上传的图片：objectKey 为规范化原图，previewKey 为送模型前最长边 ≤ maxEdge 的派生图。
export const attachments = pgTable('attachment', { id: varchar('id', { length: 36 }).primaryKey(), ownerUserId: bigint('owner_user_id', { mode: 'bigint' }).notNull(), appId: bigint('app_id', { mode: 'bigint' }), originalName: varchar('original_name', { length: 256 }).notNull(), mediaType: varchar('media_type', { length: 32 }).notNull(), bytes: integer('bytes').notNull(), width: integer('width').notNull(), height: integer('height').notNull(), hash: char('hash', { length: 64 }).notNull(), objectKey: varchar('object_key', { length: 512 }).notNull(), previewKey: varchar('preview_key', { length: 512 }).notNull(), createTime: timestamp('create_time', { mode: 'string', precision: 3 }).notNull(), updateTime: timestamp('update_time', { mode: 'string', precision: 3 }).notNull() }, t => [index('idx_attachment_owner').on(t.ownerUserId), index('idx_attachment_app').on(t.appId)]);
const modelTimes = { createTime: timestamp('create_time', { mode: 'string', precision: 3 }).notNull(), updateTime: timestamp('update_time', { mode: 'string', precision: 3 }).notNull() };
export const modelProviders = pgTable('model_provider', { id: varchar('id', { length: 64 }).primaryKey(), displayName: varchar('display_name', { length: 128 }).notNull(), apiFormat: varchar('api_format', { length: 64 }).notNull(), baseUrl: varchar('base_url', { length: 2048 }).notNull(), apiKeyEnv: varchar('api_key_env', { length: 128 }), apiKeyCiphertext: varchar('api_key_ciphertext', { length: 2048 }), options: jsonb('options').notNull(), headers: jsonb('headers'), enabled: integer('enabled').notNull().default(0), ...modelTimes });
export const modelAliases = pgTable('model_alias', { alias: varchar('alias', { length: 64 }).primaryKey(), providerId: varchar('provider_id', { length: 64 }).notNull().references(() => modelProviders.id), modelName: varchar('model_name', { length: 256 }).notNull(), capabilities: jsonb('capabilities').notNull(), settings: jsonb('settings').notNull(), enabled: integer('enabled').notNull().default(0), ...modelTimes }, t => [index('idx_model_alias_provider').on(t.providerId)]);
export const modelConfigState = pgTable('model_config_state', { id: varchar('id', { length: 32 }).primaryKey(), revision: bigint('revision', { mode: 'bigint' }).notNull(), refreshEpoch: bigint('refresh_epoch', { mode: 'bigint' }).notNull(), updateTime: timestamp('update_time', { mode: 'string', precision: 3 }).notNull() });

// ---- harness 控制面（migrations/006_harness_control.sql）----
// 只供 control-store / generation-lifecycle 使用。generation 新增的 phase/deadline/input_watermark/parent_version_sha
// 由迁移 006 添加，这里不重写既有表定义，需要时用原生 SQL 读。
export type AuthorityState = 'idle' | 'active' | 'draining';
export type InputMode = 'start' | 'steer' | 'followUp' | 'write' | 'answer';
export type InputStatus = 'accepted' | 'placed' | 'resolved' | 'withdrawn' | 'unanswered';
export type ExecutionStatus = 'preparing' | 'active' | 'draining' | 'sealed' | 'failed';
export type SnapshotKind = 'draft' | 'version' | 'template';
export type SnapshotStatus = 'freezing' | 'sealed' | 'failed';
export type AttemptKind = 'model' | 'build' | 'tool';
export type AttemptStatus = 'prepared' | 'sent' | 'succeeded' | 'failed' | 'unknown';
export type DeliveryStatus = 'ready' | 'superseded';
export type DeploymentStatus = 'running' | 'ready' | 'failed';

const controlTimes = { createTime: timestamp('create_time', { mode: 'string', precision: 3 }).notNull(), updateTime: timestamp('update_time', { mode: 'string', precision: 3 }).notNull() };

export const appAuthority = pgTable('app_authority', {
  appId: bigint('app_id', { mode: 'bigint' }).primaryKey().references(() => apps.id, { onDelete: 'cascade' }),
  ownerEpoch: bigint('owner_epoch', { mode: 'number' }).notNull().default(0),
  holder: text('holder'),
  processId: text('process_id'),
  expiresAt: timestamp('expires_at', { mode: 'string', precision: 3 }),
  state: varchar('state', { length: 16 }).$type<AuthorityState>().notNull().default('idle'),
  draftSnapshotId: varchar('draft_snapshot_id', { length: 36 }),
  previewDeliveryId: varchar('preview_delivery_id', { length: 36 }),
  previewRevision: bigint('preview_revision', { mode: 'number' }).notNull().default(0),
  updateTime: timestamp('update_time', { mode: 'string', precision: 3 }).notNull(),
});

export const generationInputs = pgTable('generation_input', {
  id: varchar('id', { length: 36 }).primaryKey(),
  appId: bigint('app_id', { mode: 'bigint' }).notNull().references(() => apps.id, { onDelete: 'cascade' }),
  generationId: varchar('generation_id', { length: 36 }).notNull().references(() => generations.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  mode: varchar('mode', { length: 16 }).$type<InputMode>().notNull(),
  message: text('message').notNull(),
  status: varchar('status', { length: 16 }).$type<InputStatus>().notNull(),
  sdkSubmissionId: bigint('sdk_submission_id', { mode: 'number' }),
  sdkEntryId: varchar('sdk_entry_id', { length: 64 }),
  ...controlTimes,
}, t => [uniqueIndex('uk_generation_input_request').on(t.appId, t.requestId), uniqueIndex('uk_generation_input_seq').on(t.generationId, t.seq)]);

export const generationExecutions = pgTable('generation_execution', {
  id: varchar('id', { length: 36 }).primaryKey(),
  appId: bigint('app_id', { mode: 'bigint' }).notNull().references(() => apps.id, { onDelete: 'cascade' }),
  generationId: varchar('generation_id', { length: 36 }).notNull().references(() => generations.id, { onDelete: 'cascade' }),
  conversationId: bigint('conversation_id', { mode: 'number' }),
  epoch: bigint('epoch', { mode: 'number' }).notNull(),
  directory: text('directory').notNull(),
  baselineKind: varchar('baseline_kind', { length: 16 }).notNull(),
  baselineSnapshotId: varchar('baseline_snapshot_id', { length: 36 }),
  baselineVersionSha: char('baseline_version_sha', { length: 40 }),
  status: varchar('status', { length: 16 }).$type<ExecutionStatus>().notNull(),
  ...controlTimes,
}, t => [uniqueIndex('uk_generation_execution_generation').on(t.generationId), uniqueIndex('uk_generation_execution_app_open').on(t.appId).where(sql`status in ('preparing', 'active', 'draining')`)]);

export const sourceSnapshots = pgTable('source_snapshot', {
  id: varchar('id', { length: 36 }).primaryKey(),
  appId: bigint('app_id', { mode: 'bigint' }).notNull().references(() => apps.id, { onDelete: 'cascade' }),
  generationId: varchar('generation_id', { length: 36 }),
  kind: varchar('kind', { length: 16 }).$type<SnapshotKind>().notNull(),
  parentVersionSha: char('parent_version_sha', { length: 40 }),
  digest: char('digest', { length: 64 }).notNull(),
  directory: text('directory').notNull(),
  status: varchar('status', { length: 16 }).$type<SnapshotStatus>().notNull(),
  message: text('message'),
  ...controlTimes,
}, t => [index('idx_source_snapshot_app_time').on(t.appId, t.createTime), index('idx_source_snapshot_generation').on(t.generationId)]);

export const generationAttempts = pgTable('generation_attempt', {
  id: varchar('id', { length: 36 }).primaryKey(),
  executionId: varchar('execution_id', { length: 36 }).notNull().references(() => generationExecutions.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 16 }).$type<AttemptKind>().notNull(),
  operationNo: integer('operation_no').notNull(),
  requestSummary: jsonb('request_summary'),
  status: varchar('status', { length: 16 }).$type<AttemptStatus>().notNull(),
  result: jsonb('result'),
  usage: jsonb('usage'),
  ...controlTimes,
}, t => [uniqueIndex('uk_generation_attempt_operation').on(t.executionId, t.kind, t.operationNo)]);

export const generationQuestions = pgTable('harness_question', {
  id: varchar('id', { length: 36 }).primaryKey(),
  appId: bigint('app_id', { mode: 'bigint' }).notNull().references(() => apps.id, { onDelete: 'cascade' }),
  generationId: varchar('generation_id', { length: 36 }).notNull().references(() => generations.id, { onDelete: 'cascade' }),
  prompt: text('prompt').notNull(),
  status: varchar('status', { length: 16 }).$type<'open' | 'answered' | 'cancelled'>().notNull(),
  answerInputId: varchar('answer_input_id', { length: 36 }),
  ...controlTimes,
}, t => [uniqueIndex('uk_harness_question_app_open').on(t.appId).where(sql`status = 'open'`)]);

export const generationTransitions = pgTable('generation_transition', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  appId: bigint('app_id', { mode: 'bigint' }).notNull(),
  generationId: varchar('generation_id', { length: 36 }).notNull(),
  fromState: varchar('from_state', { length: 16 }),
  toState: varchar('to_state', { length: 16 }).notNull(),
  reason: text('reason'),
  createTime: timestamp('create_time', { mode: 'string', precision: 3 }).notNull(),
}, t => [index('idx_generation_transition_generation').on(t.generationId, t.createTime)]);

export const generationDeliveries = pgTable('generation_delivery', {
  id: varchar('id', { length: 36 }).primaryKey(),
  appId: bigint('app_id', { mode: 'bigint' }).notNull().references(() => apps.id, { onDelete: 'cascade' }),
  generationId: varchar('generation_id', { length: 36 }),
  versionSha: char('version_sha', { length: 40 }).notNull(),
  sourceSnapshotId: varchar('source_snapshot_id', { length: 36 }).notNull(),
  directory: text('directory').notNull(),
  status: varchar('status', { length: 16 }).$type<DeliveryStatus>().notNull(),
  createTime: timestamp('create_time', { mode: 'string', precision: 3 }).notNull(),
}, t => [uniqueIndex('uk_generation_delivery_version').on(t.appId, t.versionSha)]);

export const appPreviewPointers = pgTable('app_preview_pointer', {
  appId: bigint('app_id', { mode: 'bigint' }).primaryKey().references(() => apps.id, { onDelete: 'cascade' }),
  deliveryId: varchar('delivery_id', { length: 36 }),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  updateTime: timestamp('update_time', { mode: 'string', precision: 3 }).notNull(),
});

export const appDeployments = pgTable('app_deployment', {
  id: varchar('id', { length: 36 }).primaryKey(),
  appId: bigint('app_id', { mode: 'bigint' }).notNull().references(() => apps.id, { onDelete: 'cascade' }),
  versionSha: char('version_sha', { length: 40 }).notNull(),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  status: varchar('status', { length: 16 }).$type<DeploymentStatus>().notNull(),
  deployKey: varchar('deploy_key', { length: 64 }),
  error: text('error'),
  ...controlTimes,
}, t => [uniqueIndex('uk_app_deployment_request').on(t.appId, t.requestId), uniqueIndex('uk_app_deployment_app_running').on(t.appId).where(sql`status = 'running'`)]);

// ---- 计费（migrations/008_credit_rate_card.sql）----
/** 上游成本口径：峰时/谷时价可追溯，不知道就留 unknown，不拿售价折算冒充真实成本。 */
export type RateCostBasis = 'peak' | 'off-peak' | 'unknown';

// 费率表：只追加。同一 (provider_id, model_name) 可以在不同 effective_from 上有多个版本，改价只加行。
export const creditRateCard = pgTable('credit_rate_card', {
  providerId: varchar('provider_id', { length: 64 }).notNull(),
  modelName: varchar('model_name', { length: 256 }).notNull(),
  effectiveFrom: timestamp('effective_from', { mode: 'string', precision: 3 }).notNull(),
  creditInputMiss: integer('credit_input_miss').notNull(),
  creditInputHit: integer('credit_input_hit').notNull(),
  creditOutput: integer('credit_output').notNull(),
  usdInputMiss: numeric('usd_input_miss', { precision: 12, scale: 6 }),
  usdInputHit: numeric('usd_input_hit', { precision: 12, scale: 6 }),
  usdOutput: numeric('usd_output', { precision: 12, scale: 6 }),
  costBasis: varchar('cost_basis', { length: 16 }).$type<RateCostBasis>(),
  costSource: varchar('cost_source', { length: 512 }),
  note: text('note'),
  createdBy: bigint('created_by', { mode: 'bigint' }),
  createTime: timestamp('create_time', { mode: 'string', precision: 3 }).notNull(),
}, t => [index('idx_credit_rate_card_model').on(t.providerId, t.modelName, t.effectiveFrom.desc())]);
