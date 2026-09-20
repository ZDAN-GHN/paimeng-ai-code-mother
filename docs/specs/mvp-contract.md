# MVP Document

## 1. MVP Objective

### Problem

非技术 Application Owner 无法自行完成应用开发、验证、公开部署与持续运维，也不应处理代码、生产配置或基础设施。

### Goal

让 Owner 用自然语言获得一个已验证、可公开访问、由平台托管且可继续修改的 TypeScript Web 应用。

### Success Definition

Owner 能创建应用、提交需求、获得健康公开运行的应用 URL，并能在后续修改验证完成后确认发布更新。

---

## 2. Target User

- **Who:** 非技术的 Application Owner。
- **Context:** Owner 在 Platform 管理 Application；健康部署后，公众可访问生成应用，但不获得 Platform 管理权。

---

## 3. Core User Journey

```text
创建应用 → 描述需求 → 获得已验证版本 → 首次自动发布 → 公众访问应用 → Owner 后续修改并确认发布
```

Owner 从自然语言需求开始，平台负责受控生成、验证、部署和运行；首次应用自动上线，后续修改由 Owner 控制上线时机。

---

## 4. MVP Scope

### Must Have

- Owner 创建并管理一个 Application — 缺少管理主体，核心旅程无法开始。
- Owner 用自然语言提交初始需求；系统在必要时澄清决定性业务问题 — 缺少明确输入，不能安全生成应用。
- Agent 在隔离环境中生成应用，Platform 冻结并验证候选版本 — 缺少可信验证，无法交付或发布。
- 首次验证通过后自动部署并提供公开入口 — 缺少公开运行，无法获得托管应用价值。
- Owner 查看生成、验证、发布和运行状态 — 缺少状态，无法判断应用是否可用。
- 后续修改验证通过后由 Owner 确认发布 — 缺少此行为，应用不能安全持续演进。
- 有效订阅下保持运行；到期后宽限、停服保留、续费恢复 — 缺少此行为，无法提供周期付费托管服务。
- [IMPLEMENTATION NECESSITY] Platform 关联 Application、Task、Run、Snapshot、Validation、SourceRevision、Release 与 Deployment — 缺少证据链，无法可信验证、发布或恢复。

### Optional

- Owner 在后续更新发布前查看预览 — 有帮助，但不影响首次闭环。
- 用户可读的 Profile 语义 diff — 有助于理解变更，但首版可使用简洁业务摘要。
- 完整自助账单与订阅管理界面 — 不影响首版托管闭环。

### Out of Scope

- Subagent、多 Agent 编排、并发写入与 Agent DAG — 单 Agent 闭环足以验证 MVP。
- 外部 Git 写入、双向同步、外部 CI 直接发布 — 会绕过版本和验证证据链。
- 多技术栈、多部署环境、多服务拓扑、用户自带基础设施。
- 灰度、Canary、定时发布、多人审批与自动低风险发布。
- 破坏性生产数据库迁移、大规模 backfill、停机迁移和通用反向迁移。
- Platform 统一管理生成应用内部的认证、角色、RBAC 或业务数据权限。
- 复杂计费、退款、最终数据删除和保留治理。

### Future

- 派生 Run 的 Research / Review。
- 多 Agent、并发 Task 与复杂调度。
- Git Controlled Import、外部 CI 集成与 Drift Detection。
- 复杂数据库演进、发布策略和订阅治理。

---

## 5. Functional Behavior

### Application Creation and Management

#### Purpose

让 Owner 获得一个由 Platform 管理的应用生命周期入口。

#### Trigger

Owner 创建 Application。

#### Preconditions

Owner 具备 Platform 中的 Application 管理权。

#### Behavior

系统创建 Application；Application Owner 与 System Administrator 可管理、发布或删除该 Application，其他平台用户不能执行这些管理操作。

#### Result

Owner 获得可提交需求和查看生命周期状态的 Application。

#### Edge Cases

- `Explicitly handled`: 非 Owner、非 System Administrator 的管理请求被拒绝。

### Requirement to Validated Version

#### Purpose

将明确的自然语言目标转化为经过验证的应用版本。

#### Trigger

Owner 提交初始需求或后续修改需求。

#### Preconditions

Application 存在；对于后续修改，存在当前稳定源码基线。

#### Behavior

系统保留 Requirement 原文并形成 Task。业务目标或完成结果不明确时，Task 进入 `blocked`，系统一次提出一个决定性问题。明确后，Agent 在隔离环境中修改应用；Platform 冻结 Candidate Source Snapshot 并完成必要验证。只有验证通过的 Snapshot 才能形成 SourceRevision。

#### Result

Owner 看到应用正在生成、需要澄清、验证失败或验证通过的状态。

#### Edge Cases

- `Explicitly handled`: 验证失败时不得形成可发布版本。
- `Explicitly handled`: 破坏性或不可兼容的生产 Migration 被阻断，不进入发布。

### Initial Public Deployment

#### Purpose

让首次验证通过的应用成为公众可访问的托管服务。

#### Trigger

首次 Application 的版本完成必要验证。

#### Preconditions

Task 已验证通过，存在可部署版本。

#### Behavior

Platform 自动创建 Release、部署应用并执行部署后健康检查。健康 Deployment 提供公开运行入口，包括未注册 Platform 账号的访问者。

#### Result

Owner 看到应用已上线和公开访问地址；公众可访问运行中的应用。

#### Edge Cases

- `Explicitly handled`: 部署未健康时，Platform 不将该版本表述为已上线，并保持上一健康版本；首次部署不存在上一版本时，应用保持未上线。

### Update Publishing

#### Purpose

让 Owner 控制已上线应用的新版本何时影响 Production。

#### Trigger

后续修改的 Task 验证通过。

#### Preconditions

Application 已存在健康 Deployment；存在新的已验证目标版本。

#### Behavior

系统以业务语言展示新版本摘要和可用预览；只有 Owner 确认“发布更新”后，Platform 才创建 Release 并部署。

#### Result

Owner 可选择何时让已验证更新对公众生效。

#### Edge Cases

- `Explicitly handled`: Owner 未确认发布时，当前健康 Deployment 保持不变。
- `Explicitly handled`: 新版本部署失败后，修复产生的新版本仍需 Owner 再次确认发布。

### Subscription Runtime Lifecycle

#### Purpose

按周期付费提供应用部署与运维服务。

#### Trigger

订阅有效、支付失败、订阅到期或 Owner 续费。

#### Preconditions

Application 存在。

#### Behavior

有效订阅下，健康 Deployment 持续公开运行。支付失败或到期后进入宽限期；宽限期结束停止公开 Deployment，但保留应用、版本、数据库和记录。续费后恢复上一健康 Release。

#### Result

Owner 看到运行、宽限、停服或恢复状态；停服不删除 Application 历史或数据。

#### Edge Cases

- `Explicitly handled`: 停服只改变公开运行可用性，不改写 Trusted Profile、SourceRevision 或历史 Release。

---

## 6. Business Rules

- Requirement 原文不可被 Agent 改写；决定性业务歧义必须阻断并澄清。
- Agent 不能自行宣布 Task 完成；Platform 只能基于同一 Candidate Source Snapshot 的必要验证将 Task 标记为 `validated`。
- 每个拟晋升 Snapshot 必须明确 Profile 处置：`changed`、`unchanged` 或 `uncertain`；`uncertain` 禁止晋升。
- 已上线 Application 的后续版本必须经 Owner 确认发布。
- Production Migration 仅允许向前、向后兼容且可确定执行的 Schema Evolution。
- Platform 管理权不定义生成应用内部的最终用户权限或业务权限。

---

## 7. State Model

```text
created → ready → executing → validated → released
                    ↓
                 blocked / failed
```

- **Task `blocked`** — 目标或业务含义未明确；允许 Owner 回答关键问题；禁止实施与晋升；澄清后重新归一化。
- **Task `executing`** — Agent 正在隔离环境工作；同一 Application 禁止第二个写入型 Run；验证通过或失败后离开。
- **Task `validated`** — 指定 Snapshot 已通过必要验证；首次应用可自动部署，后续更新等待 Owner 发布确认。
- **Deployment `healthy`** — Release 对外运行；允许公众访问。
- **Deployment `stopped_for_subscription`** — 宽限期结束后公开运行停止；续费后恢复上一健康 Release。

---

## 8. Acceptance Criteria

- **创建与管理 Application**
  - Given Owner 已进入 Platform
  - When Owner 创建 Application
  - Then Owner 可提交需求并查看其生命周期状态，其他普通平台用户不能修改或删除该 Application。

- **需求归一化与澄清**
  - Given Owner 提交需求
  - When 系统无法确定会改变业务结果的问题
  - Then Task 进入 `blocked`，并只向 Owner 提出一个决定性问题。

- **生成与验证**
  - Given Task 已明确并开始执行
  - When Agent 完成修改并提交候选版本
  - Then Platform 对冻结 Snapshot 执行必要验证，失败版本不得成为 SourceRevision 或可发布版本。

- **首次公开部署**
  - Given 首次版本验证通过
  - When Platform 完成 Deployment 和健康检查
  - Then Owner 看到公开 URL，未注册 Platform 账号的访问者可访问运行应用。

- **后续更新发布**
  - Given 已上线 Application 的更新版本验证通过
  - When Owner 尚未确认发布
  - Then 当前健康 Deployment 不变。
  - When Owner 确认发布更新
  - Then Platform 部署该已验证版本并更新运行状态。

- **订阅生命周期**
  - Given 健康 Deployment 正在运行
  - When 订阅到期且宽限期结束
  - Then Platform 停止公开运行但保留应用、版本和数据。
  - Given Application 已因订阅停服
  - When Owner 续费
  - Then Platform 恢复上一健康 Release。

---

## 9. Constraints

- MVP 仅支持固定的 TypeScript 全栈应用形态、单 HTTP 服务和平台托管关系数据库。
- Agent 只能在当前 Run 的隔离 Sandbox/Workspace 中自由开发，不得访问宿主机、其他 Workspace、Production 或生产凭据。
- Production 构建、密钥注入、Migration、流量切换、健康检查与回滚由 Platform 执行。
- Application 源码只能经 `Task → Run → Workspace → CandidateSourceSnapshot → Validation → SourceRevision` 进入稳定版本。
- 未部署版本仅供 Owner 在受控预览/验证中使用；健康部署后提供公共运行入口。

---

## 10. Assumptions & Open Decisions

### Assumptions

- `[ASSUMPTION]`
  - **Assumption:** 首个固定应用模板、Sandbox 后端、Deployment 后端和计费接入方式待实现阶段确定。
  - **Impact:** 只影响实现选择，不改变 MVP 的目标、用户可见行为、规则或验收。
  - **How to verify / replace:** 实现开始前选择可复现的技术组合，并以隔离、验证、部署和恢复验收替换。

### Open Decisions

- None.

---

## 11. Implementation Freedom

- `[IMPLEMENTATION FREEDOM]` 代码组织、API 命名、存储方式、内部模块、具体容器实现与内部任务执行细节由实现者决定，只要不改变本 Contract 的目标、范围、行为、规则、状态和验收。
- `[IMPLEMENTATION FREEDOM]` 固定 TypeScript 全栈形态、隔离执行、不可变验证、兼容性 Migration 规则和 Platform 生产控制权不属于实现自由度。
- `[IMPLEMENTATION FREEDOM]` 实现者不得因方便而增加应用内部权限体系、外部源码写入路径、多 Agent 编排或破坏性 Migration。
