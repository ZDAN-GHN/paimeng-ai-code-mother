# TypeScript 规则

## 通用

严格模式，避免 `any`、类型断言、非空断言。优先 `unknown` + 类型窄化、判别联合、类型推导。

保持 ESM、`verbatimModuleSyntax`。

## 路径别名

前端使用 `@/*` 指向 `src/*`：

```ts
import { someUtil } from '@/utils/helper'
```

## TS Agent（目前为空）

预期结构：

- `src/generation/` 生成流程
- `src/llm/` LLM 调用
- `src/protocol/` 协议定义（Zod schema）
- `src/server/` Fastify HTTP

输入输出用 Zod 校验，状态机用 XState。

## Vue 前端

使用 `<script setup lang="ts">`，类型靠 Vue 推导：

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AppInfo } from '@/api/typings'

const app = ref<AppInfo>()
</script>
```

API 类型来自 `src/api/`（OpenAPI 生成），不重新声明。

## 验证

```bash
cd paimeng-ai-code-frontend && npm run type-check
cd paimeng-ai-code-agent && npm run type-check
```

不用 `skipLibCheck` 掩盖业务类型错误。
