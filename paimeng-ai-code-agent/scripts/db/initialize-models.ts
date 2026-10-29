import { getPool } from '../../src/server/db';
import { initializeModelConfigFromEnv } from '../../src/server/models/store';

const result = await initializeModelConfigFromEnv();
console.log(result.initialized
  ? `模型配置已初始化：提供商 ${result.providerId}，版本 ${result.revision}`
  : `模型配置已存在，未做修改：版本 ${result.revision}`);
await getPool().end();
