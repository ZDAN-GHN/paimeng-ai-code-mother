-- 生成限流窗口搬到 Redis（src/server/redis.ts + src/server/rate-limit.ts）：
-- 固定窗口计数不再占用产品库表，额度以哈希键 user:<id> / ip:<ip> / api:app.chat.gen.code 存储。
DROP TABLE IF EXISTS rate_limit;
