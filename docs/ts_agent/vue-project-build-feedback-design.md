# vue_project 构建反馈环设计

> 关联：#56、`docs/ts_agent/codegen-multi-type-design.md` §4.6、`docs/ts_agent/architecture.md` §1/§5/§6。
>
> 状态：已决策，设计票；不包含运行时实现、依赖安装或 Java/前端改动。
>
> 决策日期：2026-09-10。

## 1. 决策摘要

选择**方案 B 的受控变体**：Java `BuilderExecutor` 是 `vue_project` 的唯一权威构建执行器；TS Agent 只做不执行代码的结构预检，并通过 Java 内部回调接收构建结果。构建失败时，Agent 将结构化错误作为一次有限的 coder 修复输入，重新提交构建；达到上限后进入失败终态并按既有 run/积分协议处理。

```text
生成文件
  -> Agent 结构预检（不执行 npm、不安装依赖）
  -> Java BuilderExecutor 构建（权威）
  -> Java 返回结构化 build result
  -> 成功：继续 review/deploy
  -> 失败：错误摘要回灌 coder，有限重试
  -> 重试耗尽：failed + 既有退款/结算路径
```

这里的“反馈环”不是让 Agent 直接拥有一套 Node 构建系统，而是把构建器结果纳入现有 planner → coder → reviewer 的有界收敛流程。Java 仍然负责生成物的最终构建和部署，避免出现“Agent 认为通过、Java 最终构建失败”两套权威。

## 2. 为什么不选 Agent 侧 `npm build`

| 维度 | 方案 A：Agent 侧构建 | 方案 B：Java BuilderExecutor 回调 | 决策 |
|---|---|---|---|
| 错误反馈延迟 | 低，review 内即可反馈 | 高一个内部回调往返 | B 可接受，回调仍在同一 run 内 |
| 权威一致性 | 可能与 Java 构建环境漂移 | 与最终部署环境一致 | B 明显更好 |
| 不可信代码风险 | Agent 需要执行 `npm install/build` | Agent 不执行生成代码 | B 明显更安全 |
| 依赖缓存 | 需要按项目隔离、失效和清理 | 复用 Java 现有构建边界 | B 成本更低 |
| Agent 运行时复杂度 | 引入 Node 工具链、进程治理 | 只增加回调和错误映射 | B 更符合当前架构 |
| 首次成功率 | 反馈更快，可能更高 | 依赖 coder 质量和回调延迟 | A 有局部优势 |

方案 A 只有在后续证明 Java 构建反馈延迟或吞吐成为实际瓶颈时才重新评估。不能为了降低一轮回调延迟，在 Agent 服务中复制一套会执行不可信项目代码的构建基础设施。

## 3. 责任边界

### TS Agent 负责

- 检查 `package.json`、构建配置、入口 SFC 和文件路径的静态结构。
- 生成唯一 `buildRequestId`，绑定 `runId`、`appId` 和工作区版本。
- 调用 Java 内部构建接口并等待结构化结果。
- 只把经过大小限制和字段过滤的错误摘要反馈给 coder。
- 对同一 run 执行有界重试；不自行降级为 html 或跳过构建。

### Java `BuilderExecutor` 负责

- 在受控构建环境执行 `npm ci`/构建命令，具体命令沿现有 BuilderExecutor 约定落地。
- 生成锁文件、依赖缓存和构建产物，并返回结果。
- 限制工作区、环境变量、网络、CPU、内存、磁盘和执行时长。
- 不把原始 stdout/stderr 无限制地回传给 Agent。
- 以 `runId + buildRequestId` 幂等处理重复请求。

### 本票不决定

- Java 具体容器/沙箱技术选型。
- npm registry 镜像和组织级依赖白名单的最终名单。
- 预览 iframe 的运行时实现。
- 真实构建命令的 Java API 改造。

## 4. 构建反馈契约

后续实现必须保留以下字段语义；具体 HTTP 路径可沿现有 Agent→Java 内部回调模式命名，但不得删除幂等键或把失败降级为普通字符串。

请求：

```json
{
  "runId": "run-01JEXAMPLE",
  "buildRequestId": "build-01JEXAMPLE",
  "appId": "app-123",
  "codeGenType": "vue_project",
  "workspaceVersion": "sha256:...",
  "attempt": 1,
  "commandProfile": "vue_project_build"
}
```

成功响应：

```json
{
  "runId": "run-01JEXAMPLE",
  "buildRequestId": "build-01JEXAMPLE",
  "status": "passed",
  "workspaceVersion": "sha256:...",
  "artifactPath": "dist",
  "diagnostics": [],
  "durationMs": 18342
}
```

失败响应：

```json
{
  "runId": "run-01JEXAMPLE",
  "buildRequestId": "build-01JEXAMPLE",
  "status": "failed",
  "workspaceVersion": "sha256:...",
  "artifactPath": null,
  "diagnostics": [
    {
      "code": "MODULE_NOT_FOUND",
      "file": "src/App.vue",
      "line": 12,
      "column": 7,
      "message": "Cannot resolve './components/Hero.vue'"
    }
  ],
  "durationMs": 12004
}
```

字段约束：

- `status` 只允许 `passed`、`failed`、`timed_out`、`rejected`。
- `workspaceVersion` 必须与 Agent 提交构建的工作区版本相等；不等则视为过期结果，不得反馈给 coder。
- `diagnostics` 最多 20 条，每条 `message` 最多 1000 字符；路径必须是工作区相对路径，禁止返回绝对路径、环境变量、密钥或完整命令行。
- `artifactPath` 仅允许构建器声明的相对 `dist` 路径；Agent 不得接受任意路径。
- 重复 `buildRequestId` 必须返回同一逻辑结果，不能再次执行有副作用的构建。

## 5. 状态与重试

构建不是新的长期 run phase；它是 `review` 阶段中的一个有界门禁尝试。建议事件使用现有 milestone/tool/review 语义，不新增 SSE 事件类型。

```text
review_entered
  -> build_requested(attempt=1)
  -> build_passed -> review_continue
  -> build_failed -> coder_repair
  -> coder_repair -> build_requested(attempt+1)
  -> attempts exhausted -> failed
```

约束：

- 默认最多 2 次构建修复重试，即最多 3 次构建尝试；实际值由现有质量尝试上限统一注入，不能由模型修改。
- `timed_out`、`rejected` 和构建器不可用都属于失败输入，不可当作构建通过。
- 构建结果过期、回调鉴权失败或 schema 校验失败时，不反馈原始内容；记录内部错误并结束本次尝试。
- 修复输入只包含结构化诊断和必要的项目相对路径，不包含任意 shell 输出。
- 每次修复后必须重新提交整个工作区版本并重新构建；禁止对旧 `dist` 做增量假通过。

## 6. 安全威胁模型

生成的 Vue 项目是**不可信输入**。即使来源是模型，也必须按用户可控代码处理。

| 威胁 | 例子 | 控制措施 | 验证证据 |
|---|---|---|---|
| 安装脚本执行宿主命令 | `postinstall` 调用 `curl`, 读取 SSH key | 独立低权限构建环境；禁用/审查 lifecycle scripts；无宿主凭据 | 构建器安全测试 |
| 依赖供应链投毒 | 恶意或拼写相近 npm 包 | 锁文件；允许 registry；依赖审计与包大小/数量限制 | 依赖策略测试/审计记录 |
| 网络外传 | 构建脚本上传环境变量或源码 | 默认无外网；若 registry 必须访问，使用受限代理且只允许 registry 域名 | 网络策略测试 |
| 路径逃逸 | `../`, symlink 指向宿主文件 | 解析后路径必须位于工作区；拒绝越界 symlink | 路径逃逸测试 |
| 资源耗尽 | 无限脚本、大量依赖、超大产物 | CPU/内存/磁盘/进程/文件数限制，硬超时 | 限额测试 |
| 日志泄密 | token 出现在 stdout/stderr | 日志字段过滤、截断、敏感模式脱敏 | 脱敏测试 |
| 缓存污染 | 项目 A 复用项目 B 的 node_modules | 缓存键绑定 lockfile hash、Node/npm 版本和构建配置；不共享可写 node_modules | 缓存隔离测试 |
| 产物越界 | 构建器返回任意 artifactPath | 只允许声明的工作区内 `dist`，服务端二次校验 | artifact 校验测试 |

### 安全默认值

- 构建环境不可访问 Java/TS Agent 宿主的凭据、socket、源码目录和生产网络。
- 不允许通过 `NODE_OPTIONS`、`PATH`、`npm_config_*` 等环境变量注入执行选项；环境变量采用固定白名单。
- 依赖安装失败即构建失败；禁止静默跳过 install 或自动切换 registry。
- 依赖安装策略、是否允许 lifecycle scripts、网络代理和缓存共享必须在 Java BuilderExecutor 的实现票中冻结；本票不以“将来加沙箱”作为安全保证。

## 7. 超时、并发与缓存

建议初始约束（实现时应配置化且有上限）：

| 项目 | 初始值 | 规则 |
|---|---:|---|
| npm install 超时 | 120 秒 | 超时返回 `timed_out`，终止进程树 |
| npm build 超时 | 120 秒 | 与 install 分开计时，终止进程树 |
| 单次构建总超时 | 180 秒 | 包含排队和清理时间 |
| 构建修复尝试 | 3 次 | 2 次修复 + 首次构建 |
| diagnostics 条数 | 20 | 超出截断并标记截断 |
| diagnostic message | 1000 字符 | 超出截断 |
| 依赖包数量 | 200 | 超限 `rejected` |
| 工作区文件数 | 5000 | 超限 `rejected` |
| 产物大小 | 50 MiB | 超限 `rejected` |

这些是保护上限，不是对所有项目的性能承诺。实际值必须通过真实项目样本校准，但调参不能超过表中安全上限而不产生新的设计变更。

缓存规则：

- 缓存命中键至少为 `sha256(package-lock.json 或 pnpm-lock.yaml) + Node major + npm major + commandProfile + builderImageVersion`。
- 没有锁文件时禁止跨 run 复用依赖缓存；可以直接拒绝项目，或在实现票中明确生成锁文件的可信流程。
- 缓存只读挂载到构建环境；构建不能回写其他项目的缓存。
- 构建产物不作为依赖缓存；每个 `workspaceVersion` 独立生成并校验。
- 缓存 miss 是正常路径，不得改变构建结果语义；缓存失效或损坏必须删除并冷启动。

## 8. 后续实现范围

### 必须单独建票或追加到明确 owner 的实现票

1. Java BuilderExecutor 的 `vue_project_build` command profile、内部请求/响应 schema、鉴权和 `runId + buildRequestId` 幂等。
2. 构建隔离环境：低权限用户、工作区限制、进程树终止、CPU/内存/磁盘/网络策略。
3. npm 依赖策略：锁文件要求、registry allowlist、lifecycle script 策略、依赖数量/大小限制。
4. TS Agent review 门禁接线：结构预检、回调等待、诊断过滤、有限修复轮和终态映射。
5. `vue_project` 入口/结构门禁及 `dist` 产物契约。
6. fake BuilderExecutor 测试矩阵，以及主 agent 执行的真实 provider/真实 Java 构建验证。

### 明确不属于后续实现的内容

- 在 TS Agent 中安装 npm 或执行项目 build。
- 为 vue_project 复制一套独立 XState 状态机。
- 自动把 vue_project 降级为 html 或 multi_file。
- 用消息队列替代本票定义的同步内部回调。若构建耗时导致同步回调不可用，应另开可靠性设计票。

## 9. Agent Design Review 自审报告

审查对象：本文件；引用已核对：`AGENTS.md`、`docs/ts_agent/architecture.md`、`docs/ts_agent/codegen-multi-type-design.md`、`docs/ts_agent/contract.md`、现有 `BuilderExecutor` 路径由多类型设计文档列出。

| 要素 | 结论 | 证据 |
|---|---|---|
| 目标与背景 | 通过 | §1 给出单一决策、数据流和交付边界 |
| 范围界定 | 通过 | §3、§8 明确 Agent/Java 责任及本票不实施项 |
| 现状与约束 | 通过 | §3、§7 给出既有责任边界和明确安全上限 |
| 技术方案 | 通过 | §4 提供请求/成功/失败完整 JSON，§5 提供状态转换 |
| 任务分解 | 通过 | §8 按 owner 拆分后续实现产物和依赖 |
| 验收标准 | 通过 | §4-§7 的字段、状态、限额和安全测试均可客观验证 |
| 风险与陷阱 | 通过 | §6 覆盖供应链、外传、逃逸、资源、日志、缓存污染 |
| 参考资料 | 通过 | 文件路径在仓库中已存在，并与当前架构约束一致 |

### 审查结论

**PASS-WITH-FIXES（无阻塞/高问题；仅保留实现阶段需冻结的具体参数）**。

该结论中的 fixes 是实施前必须在实现票冻结的 command profile、隔离技术和依赖策略，不是本设计票的未完成项；本票交付物已具备独立实现所需的决策方向、接口字段、失败语义和验证清单。

## 10. 参考资料

- `AGENTS.md`
- `docs/ts_agent/architecture.md` §1、§5、§6
- `docs/ts_agent/codegen-multi-type-design.md` §4.6、§6、§7
- `docs/ts_agent/agent-loop-design.md` §4.5
- `docs/ts_agent/contract.md`
- `src/main/java/com/zdan/paimengaicodemother/core/builder/BuilderExecutor.java`（由后续实现票核对实际路径与 API）
