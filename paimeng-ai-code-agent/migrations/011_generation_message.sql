-- 一次生成对应的助手回复（前端按消息展示用量需要这条显式链接）。
-- 助手消息 id 由 agent.ts 的 generateId 生成，形如 <generationId>-assistant；这里直接存消息 id，
-- 不靠解析字符串，也不给 ts_message 加列（消息体本身已经是 JSON）。
ALTER TABLE ts_generation ADD COLUMN messageId VARCHAR(64) NULL;
