-- 提供商自定义请求头（JSON 列，可空；旧记录为 NULL，读取时按空集合处理）。
-- 与 protocol options 分开：options 是 SDK 行为开关，headers 是随每个上游请求发送的普通 HTTP 头。
-- 本文件不是幂等的：ADD COLUMN 在列已存在时会失败；scripts/migrate.ts 用校验和跳过已应用迁移。
ALTER TABLE ts_model_provider ADD COLUMN headers JSON NULL;
