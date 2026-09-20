# 工程规则

## 改动前检查

```bash
git status --short  # 确认无用户未提交改动
```

读取目标模块 README、已有实现、调用链。不覆盖用户改动。

**标准变更前必须调用 `task-evidence-analysis` 技能**，输出影响范围、验证入口、风险点和回滚方案。

## 敏感文件

只读 `.env.example`，不提交真实 `.env`、`application-local.yml`。

## 依赖安装

各子项目独立管理：

```bash
cd paimeng-ai-code-frontend && npm install
cd paimeng-ai-code-agent && npm install  # 目前为空目录
cd paimeng-ai-code-rag && uv sync
```

根目录无 workspace，不在根执行 `npm install`。

## 改动原则

- 最小改动，保持现有命名和模块边界
- 不为统一风格引入新依赖
- 注释只解释非显然原因

## 提交

每次改动创建一个 commit，message 末尾加 `Assisted-by: <agent-name>/<model-id>`。

只提交本会话改动，交付前 `git status` 应无遗留。

## 验证

改动后至少执行：

- 类型检查：`npm run type-check` 或 `./mvnw compile`
- 测试：`npm run test` 或 `./mvnw test`
- 构建：`npm run build` 或 `./mvnw package`

选择与风险匹配的验证；未运行的说明原因。

## 代码质量审查

**所有 TS Agent 生成的代码在提交前必须通过 `clean-code-reviewer` 技能审查**，重点关注：
- 函数长度和职责单一性
- 命名清晰度
- 重复代码
- 复杂度控制
- 异常处理

## PR 审查

**分支合并前必须调用 `code-review` 技能**，审查是否符合 Standards 和 Spec。

## 故障诊断

**服务异常、接口报错、SSE 断连时必须调用 `incident-evidence-diagnosis` 技能**，分离症状、重现证据、根因假设，禁止未诊断直接修复。
