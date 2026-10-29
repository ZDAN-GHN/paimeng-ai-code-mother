# 历史设计与迁移记录

这里保留已经完成或被替代的设计、迁移与实施计划。文件中的路径、命令和结论描述当时版本，不作为当前运行约定。

现行入口：[部署说明](../../pi-durable-deployment.md)、[模型配置](../../provider-convergence.md)、[数据库职责清单](../../database-inventory.md)。长期架构决策见[ADR](../../adr/0001-single-writer-authority.md)。

## 2026-10 完成的计划

- [harness-reliability.md](./harness-reliability.md) — Harness 可靠性重构与 pi-durable 1.4.0 升级（2026-10-29 归档）
- [chat-layout.md](./chat-layout.md) — 聊天页布局、可拖预览、手机端预览与对话内提示
- [chat-runtime.md](./chat-runtime.md) — 原生输入队列、断连恢复与运行中取消
- [image-voice-input.md](./image-voice-input.md) — 图片输入与语音转写
- [model-slots.md](./model-slots.md) — 模型槽位化与管理端模型分配
- [provider-api-format-and-keys.md](./provider-api-format-and-keys.md) — 多 API 格式与两种密钥来源
- [provider-connectivity-and-reasoning.md](./provider-connectivity-and-reasoning.md) — 连通性探测、模型列表与思考配置
- [provider-redis-convergence.md](./provider-redis-convergence.md) — Provider、Redis 与 harness 收敛验收
- [version-git-source.md](./version-git-source.md) — Git 作为版本事实源；后被 `version-ledger` 取代分支/合并语义
- [version-ledger.md](./version-ledger.md) — 版本台账、线性清单与只读 git

## 已被替代

- [versioning.md](./versioning.md) — 裸库与版本表方案（2026-10-21 退役）
- [version-git-native.md](./version-git-native.md) — 工作区 git 与 AI 直接操作 git；由 `version-git-source` 取代

## 更早的设计与迁移

- [agent-design-review.md](./agent-design-review.md)
- [conversation-memory.md](./conversation-memory.md)
- [model-routing.md](./model-routing.md)
- [native-coding-tools.md](./native-coding-tools.md)
- [pi-durable-data-model.md](./pi-durable-data-model.md)
- [pi-durable-deployment-notes.md](./pi-durable-deployment-notes.md)
- [pi-durable-m1.md](./pi-durable-m1.md)
- [pi-durable-m2.md](./pi-durable-m2.md)
- [pi-durable-m3.md](./pi-durable-m3.md)
- [pi-durable-m4.md](./pi-durable-m4.md)
- [pi-durable-study.md](./pi-durable-study.md)
- [provider-convergence-design.md](./provider-convergence-design.md)
