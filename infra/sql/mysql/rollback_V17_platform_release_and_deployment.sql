-- 回滚 Issue #81 / T-09 的结构变更（Flyway 无 down 迁移，手工执行）。
--
-- 顺序不可颠倒：Deployment 外键指向 Release，必须先删 Deployment。
-- 本脚本会永久丢弃首次发布事实，若线上已有健康 Deployment 必须先导出 platform_release
-- 与 platform_deployment 的内容再回滚。
DROP TRIGGER IF EXISTS platform_deployment_no_delete;
DROP TRIGGER IF EXISTS platform_deployment_terminal_guard;
DROP TRIGGER IF EXISTS platform_release_no_delete;
DROP TRIGGER IF EXISTS platform_release_immutable;
DROP TRIGGER IF EXISTS platform_release_insert_guard;

DROP TABLE IF EXISTS platform_deployment;
DROP TABLE IF EXISTS platform_release;