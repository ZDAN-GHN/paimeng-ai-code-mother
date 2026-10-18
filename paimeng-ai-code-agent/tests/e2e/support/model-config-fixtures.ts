/**
 * 浏览器用例共用的小型数据库夹具：连测试库、给账号管理员权限、铺一份确定的模型配置。
 * 列名按 Postgres 产品的 snake_case（docs/plans/archive/pi-durable-m4.md）；测试库由 `npm run db:test:setup` 建好。
 */
import pg from 'pg';
import { testDatabaseUrl } from '../../test-database-url';

export async function testConnection(): Promise<pg.Client> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('Browser tests require DATABASE_URL from the local .env file');
  const client = new pg.Client({ connectionString: new URL(testDatabaseUrl(raw)).href });
  await client.connect();
  return client;
}

export async function grantAdmin(client: pg.Client, account: string) {
  await client.query("UPDATE app_user SET user_role='admin' WHERE user_account=$1", [account]);
}

/** 清空模型配置，把版本号归零：之后的初始化必须由被测代码自己完成。 */
export async function emptyModelConfig(client: pg.Client) {
  await client.query('DELETE FROM model_alias');
  await client.query('DELETE FROM model_provider');
  await client.query(
    "INSERT INTO model_config_state (id, revision, refresh_epoch, update_time) VALUES ('models', 0, 0, timezone('UTC', now())) ON CONFLICT (id) DO UPDATE SET revision=0, refresh_epoch=0, update_time=timezone('UTC', now())",
  );
}

/** 铺一份 provider + 两个别名 + 版本 1 的配置，供管理端用例直接读写。 */
export async function seedModelConfig(client: pg.Client, baseUrl = 'https://api.example.test/v1') {
  await client.query('DELETE FROM model_alias');
  await client.query('DELETE FROM model_provider');
  await client.query(
    "INSERT INTO model_provider (id, display_name, api_format, base_url, api_key_env, options, enabled, create_time, update_time) VALUES ($1,$2,$3,$4,$5,$6,$7,timezone('UTC', now()),timezone('UTC', now()))",
    ['env-default', '默认提供商', 'openai-chat', baseUrl, 'AI_API_KEY', JSON.stringify({}), 1],
  );
  const aliasInsert =
    "INSERT INTO model_alias (alias, provider_id, model_name, capabilities, settings, enabled, create_time, update_time) VALUES ($1,$2,$3,$4,$5,$6,timezone('UTC', now()),timezone('UTC', now()))";
  await client.query(aliasInsert, [
    'codegen.default',
    'env-default',
    'test-codegen-model',
    JSON.stringify({ streaming: true, toolCalling: true, structuredOutput: false }),
    JSON.stringify({}),
    1,
  ]);
  await client.query(aliasInsert, [
    'route.classify',
    'env-default',
    'test-route-model',
    JSON.stringify({ streaming: false, toolCalling: false, structuredOutput: true }),
    JSON.stringify({}),
    1,
  ]);
  await client.query(
    "INSERT INTO model_config_state (id, revision, refresh_epoch, update_time) VALUES ('models', 1, 0, timezone('UTC', now())) ON CONFLICT (id) DO UPDATE SET revision=1, refresh_epoch=0, update_time=timezone('UTC', now())",
  );
}

/** jsonb 回来已经是对象，字符串则是 JSON 文本；两种都还原成对象。 */
export async function readProviderHeaders(client: pg.Client): Promise<Record<string, string>> {
  const { rows } = await client.query("SELECT headers FROM model_provider WHERE id='env-default'");
  const value = (rows as { headers: unknown }[])[0]?.headers;
  return typeof value === 'string' ? (JSON.parse(value) as Record<string, string>) : (value as Record<string, string>);
}
