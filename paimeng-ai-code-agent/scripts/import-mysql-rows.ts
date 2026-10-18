/**
 * 一次性业务行搬迁：旧 MySQL 产品库 → 产品 Postgres 库（docs/plans/pi-durable-m4.md）。
 *
 *   MYSQL_LEGACY_URL=mysql://… npm run db:import-mysql
 *
 * 搬的是业务行：用户 / 应用 / 登录会话 / 附件 / 模型配置 / 限流 / 发号器。对话数据**不搬**——
 * 转录已经迁到 pi-durable 的 `entries`（旧 `ts_message`、`chat_history`、`ts_app_summary` 放弃），
 * 所以 `app.conversation_id` 一律留空，让 harness 在下次生成时重新建会话。
 *
 * 幂等：按主键 upsert，可以重复跑；旧库保持只读，不写回。
 */
import mysql from 'mysql2/promise';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/server/schema';
import { getConfig } from '../src/server/config';

const sourceUrl = new URL(process.env.MYSQL_LEGACY_URL ?? '');
if (sourceUrl.protocol !== 'mysql:') throw new Error('需要 MYSQL_LEGACY_URL 指向旧 MySQL 产品库，例如 mysql://paimeng_ts:root@127.0.0.1:3306/paimeng_ai_code_mother_ts');

const source = await mysql.createConnection({ uri: sourceUrl.href, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
const client = new pg.Client({ connectionString: getConfig().databaseUrl });
await client.connect();
const db = drizzle(client, { schema });

const read = async (statement: string) => (await source.query<mysql.RowDataPacket[]>(statement))[0];
/** MySQL 的 JSON 列回来时可能已经是对象（驱动已解析），也可能是字符串。 */
const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
const counts: Record<string, number> = {};

try {
  const users = await read('SELECT id, userAccount, userPassword, userName, userAvatar, userProfile, userRole, createTime, updateTime, isDelete FROM user');
  for (const row of users) {
    const values = { id: BigInt(row.id), userAccount: row.userAccount, userPassword: row.userPassword, userName: row.userName, userAvatar: row.userAvatar, userProfile: row.userProfile, userRole: row.userRole, createTime: row.createTime, updateTime: row.updateTime, isDelete: Number(row.isDelete) };
    await db.insert(schema.users).values(values).onConflictDoUpdate({ target: schema.users.id, set: values });
  }
  counts.app_user = users.length;

  // conversation_id 不搬：旧会话属于旧对话层，harness 会为新库重建。
  const apps = await read('SELECT id, appName, cover, initPrompt, codeGenType, deployKey, deployedTime, editTime, priority, userId, createTime, updateTime, isDelete FROM app');
  for (const row of apps) {
    const values = { id: BigInt(row.id), appName: row.appName, cover: row.cover, initPrompt: row.initPrompt, codeGenType: row.codeGenType, deployKey: row.deployKey, deployedTime: row.deployedTime, editTime: row.editTime, priority: Number(row.priority), userId: BigInt(row.userId), conversationId: null, createTime: row.createTime, updateTime: row.updateTime, isDelete: Number(row.isDelete) };
    await db.insert(schema.apps).values(values).onConflictDoUpdate({ target: schema.apps.id, set: values });
  }
  counts.app = apps.length;

  const sessions = await read('SELECT tokenHash, userId, expiresAt FROM ts_session');
  for (const row of sessions) {
    const values = { tokenHash: row.tokenHash, userId: BigInt(row.userId), expiresAt: row.expiresAt };
    await db.insert(schema.sessions).values(values).onConflictDoUpdate({ target: schema.sessions.tokenHash, set: values });
  }
  counts.user_session = sessions.length;

  const attachments = await read('SELECT id, ownerUserId, appId, originalName, mediaType, bytes, width, height, hash, objectKey, previewKey, createTime, updateTime FROM ts_attachment');
  for (const row of attachments) {
    const values = { id: row.id, ownerUserId: BigInt(row.ownerUserId), appId: row.appId === null ? null : BigInt(row.appId), originalName: row.originalName, mediaType: row.mediaType, bytes: Number(row.bytes), width: Number(row.width), height: Number(row.height), hash: row.hash, objectKey: row.objectKey, previewKey: row.previewKey, createTime: row.createTime, updateTime: row.updateTime };
    await db.insert(schema.attachments).values(values).onConflictDoUpdate({ target: schema.attachments.id, set: values });
  }
  counts.attachment = attachments.length;

  const providers = await read('SELECT id, displayName, apiFormat, baseUrl, apiKeyEnv, apiKeyCiphertext, options, headers, enabled, createTime, updateTime FROM ts_model_provider');
  for (const row of providers) {
    const values = { id: row.id, displayName: row.displayName, apiFormat: row.apiFormat, baseUrl: row.baseUrl, apiKeyEnv: row.apiKeyEnv, apiKeyCiphertext: row.apiKeyCiphertext, options: json(row.options), headers: row.headers === null ? null : json(row.headers), enabled: Number(row.enabled), createTime: row.createTime, updateTime: row.updateTime };
    await db.insert(schema.modelProviders).values(values).onConflictDoUpdate({ target: schema.modelProviders.id, set: values });
  }
  counts.model_provider = providers.length;

  const aliases = await read('SELECT alias, providerId, modelName, capabilities, settings, enabled, createTime, updateTime FROM ts_model_alias');
  for (const row of aliases) {
    const values = { alias: row.alias, providerId: row.providerId, modelName: row.modelName, capabilities: json(row.capabilities), settings: json(row.settings), enabled: Number(row.enabled), createTime: row.createTime, updateTime: row.updateTime };
    await db.insert(schema.modelAliases).values(values).onConflictDoUpdate({ target: schema.modelAliases.alias, set: values });
  }
  counts.model_alias = aliases.length;

  const states = await read('SELECT id, revision, refreshEpoch, updateTime FROM ts_model_config_state');
  for (const row of states) {
    const values = { id: row.id, revision: BigInt(row.revision), refreshEpoch: BigInt(row.refreshEpoch), updateTime: row.updateTime };
    await db.insert(schema.modelConfigState).values(values).onConflictDoUpdate({ target: schema.modelConfigState.id, set: values });
  }
  counts.model_config_state = states.length;

  const limits = await read('SELECT limitKey, windowStart, hits FROM ts_rate_limit');
  for (const row of limits) {
    const values = { limitKey: row.limitKey, windowStart: row.windowStart, hits: Number(row.hits) };
    await db.insert(schema.rateLimits).values(values).onConflictDoUpdate({ target: schema.rateLimits.limitKey, set: values });
  }
  counts.rate_limit = limits.length;

  // 发号器下界取「旧状态」与「搬过来的主键」的较大者：旧库迁移 003 之后 ID 就在这两个空间里。
  const sequences = await read('SELECT nodeId, lastId FROM ts_snowflake_state');
  let lastId = BigInt(sequences[0]?.lastId ?? 0);
  for (const row of [...users, ...apps]) if (BigInt(row.id) > lastId) lastId = BigInt(row.id);
  const value = { nodeId: Number(sequences[0]?.nodeId ?? 0), lastId };
  await db.insert(schema.snowflakeState).values(value).onConflictDoUpdate({ target: schema.snowflakeState.nodeId, set: value });
  counts.id_sequence = 1;

  console.log(`业务行搬迁完成：${Object.entries(counts).map(([table, count]) => `${table} ${count}`).join('，')}`);
  console.log('对话数据按既定决策放弃（旧 ts_message / chat_history / ts_app_summary 未搬），app.conversation_id 已留空');
} finally {
  await source.end();
  await client.end();
}
