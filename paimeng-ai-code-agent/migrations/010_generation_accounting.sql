-- 生成任务统一记账（docs/plans/agent-design-review.md D2）：
-- ts_generation_step 每个模型步骤 / 摘要调用 / 构建尝试一行；kind 区分，round 是修复轮次（1 = 首轮）。
-- token 列为 NULL 表示上游没有返回用量（未知），0 是已知的零；两者不能混用。
-- toolCalls 只保存工具名、成败与耗时，不保存工具正文或提示词。
-- ts_generation.stopReason 是应用层停止原因；模型自己的停止原因在每个模型步骤的 finishReason 上。
CREATE TABLE IF NOT EXISTS ts_generation_step (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  generationId VARCHAR(36) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  round INT UNSIGNED NOT NULL,
  stepNumber INT UNSIGNED NOT NULL,
  modelAlias VARCHAR(64),
  providerId VARCHAR(64),
  modelName VARCHAR(256),
  upstreamProvider VARCHAR(64),
  upstreamModelId VARCHAR(256),
  durationMs INT UNSIGNED,
  modelMs INT UNSIGNED,
  toolMs INT UNSIGNED,
  inputTokens INT UNSIGNED,
  outputTokens INT UNSIGNED,
  cacheReadTokens INT UNSIGNED,
  cacheWriteTokens INT UNSIGNED,
  reasoningTokens INT UNSIGNED,
  finishReason VARCHAR(32),
  status VARCHAR(16) NOT NULL,
  stage VARCHAR(32),
  repairable TINYINT,
  toolCalls JSON,
  detail TEXT,
  createTime DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_generation_step_generation (generationId),
  -- 任务被硬删除（测试清理、未来的数据保留策略）时步骤随之级联删除。
  CONSTRAINT fk_generation_step_generation FOREIGN KEY (generationId) REFERENCES ts_generation (id) ON DELETE CASCADE
);

ALTER TABLE ts_generation ADD COLUMN stopReason VARCHAR(32) NULL;
