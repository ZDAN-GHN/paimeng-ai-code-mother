-- 应用 ↔ pi-durable 会话映射（docs/plans/pi-durable-data-model.md §4）。
-- 一个应用恰好一条 harness conversation，第一次为该应用生成时写入；NULL 表示还没生成过。
-- 生成入口在 DURABLE_ENGINE=harness 时靠它让同一应用的多次生成复用同一会话，模型能看到上一次的工具结果
-- 与文件内容，而不是每轮从零探索（docs/plans/pi-durable-m2.md）。
ALTER TABLE app ADD COLUMN conversationId BIGINT UNSIGNED NULL;
