-- 冲正理由的宽度（92 的 Admin 手工冲正，契约允许 1..500 字）。
-- 014 建 reason 列时用的是 VARCHAR(256)，比管理界面允许填写的理由短：
-- 257..500 字的理由会在插入反向分录时触发 22001，管理员拿到 500 而不是冲正结果。
-- 这里只加宽这一列，不改其它列、不建表；重复执行同一条 ALTER 是幂等的。
ALTER TABLE credit_entry ALTER COLUMN reason TYPE VARCHAR(500);
