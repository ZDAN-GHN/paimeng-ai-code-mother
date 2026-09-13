# 工程规则

## 变更前

先读目标模块的 README、调用链和权威架构文档。检查 `git status --short`，不要覆盖用户已有改动。敏感文件包括 `application-local.yml`、各服务 `.env`，只使用 example 模板，不提交真实值。

## 包管理与运行

这是多模块仓库，不使用根级 pnpm workspace。Node 子项目分别在自己的目录执行 `npm install`、`npm run type-check` 和构建命令，并使用模块目录内的 `node_modules` 与构建产物。

## 改动原则

保持模块边界和既有命名，优先最小改动。不要为了统一风格引入未安装的框架或工具。注释只解释非显然的原因，并遵循 `project-comment-style`。

## 交付

完成后运行与改动风险匹配的检查；报告未运行的检查及原因。每次改动必须创建一个带 `<Agent IDE>/<用户信息>` 标注的 Git commit，且只提交本会话产生的改动，交付时 `git status` 应无本会话遗留未提交变更。
