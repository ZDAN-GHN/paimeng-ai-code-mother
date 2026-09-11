# TypeScript 规则

## 通用

Node TS Agent 和 Vue 前端均使用 TypeScript 严格模式。避免 `any`、类型断言和非空断言；确需使用时在边界处验证原因。优先使用 `unknown` 加窄化、判别联合和推导类型。保持现有 ESM、`@/*`（前端）路径别名和 `verbatimModuleSyntax` 约定。

## TS Agent

源代码按领域位于 `src/generation`、`src/interview`、`src/llm`、`src/protocol`、`src/runs`、`src/server`。输入输出协议用 Zod schema 校验，状态流转遵循 XState 现有模型。不得让 HTTP handler 重复实现领域状态机。

## Vue

组件使用 `<script setup lang="ts">` 和 Vue 推导类型；响应式状态使用 `ref`/`computed`，跨页面状态进入 Pinia。API 类型来自 `src/api/` 生成或既有契约，不在页面中重新声明同名后端 DTO。

修改类型后至少运行对应模块的 type-check；不要把 `skipLibCheck` 当作业务类型错误的解决方案。
