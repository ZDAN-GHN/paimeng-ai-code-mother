-- harness 内环预算（PLAN.md §4）：attempt 账本补 tool 类型。
-- 只追加重建 006 的 CHECK，不改 006 本身；预算计数直接数 generation_attempt 行，不另建计数表。

ALTER TABLE generation_attempt DROP CONSTRAINT IF EXISTS generation_attempt_kind_check;
ALTER TABLE generation_attempt ADD CONSTRAINT generation_attempt_kind_check
  CHECK (kind IN ('model', 'build', 'tool'));
