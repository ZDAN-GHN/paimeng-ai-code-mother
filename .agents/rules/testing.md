# 测试与验收

## 目录结构

测试目录镜像代码路径。

跨域集成测试和 helpers/fixtures 放测试树顶层。

## 覆盖要求

新增行为至少覆盖：

- 成功路径
- 主要失败路径
- 权限/边界条件

## 命令

### TS Agent（当前为空）

```bash
cd paimeng-ai-code-agent
npm run type-check
npm run test
npm run build
```

### Vue 前端

```bash
cd paimeng-ai-code-frontend
npm run type-check      # 类型检查
npm run lint            # ESLint（写入修复）
npm run build           # 构建检查
npm run openapi2ts      # 生成 API 类型
```

### Java 后端

```bash
cd paimeng-ai-code-backend
./mvnw compile                          # 编译
./mvnw test                             # 所有测试
./mvnw -Dtest=ClassNameTest test        # 单个测试类
./mvnw verify                           # 完整验证
```

需要 JDK 21。

### Python RAG

```bash
cd paimeng-ai-code-rag
uv run pytest                           # 所有测试
uv run pytest tests/test_sse.py         # 单个测试文件
```

**当前为 P4 范围**，未授权前不安装/启动/验收。

## 验收层次

按架构逐层：

1. 服务健康
2. 鉴权
3. 接口契约
4. SSE 事件和终态
5. 工作区/构建结果

不因单个 `/healthz` 成功断言全链路可用。

## Issue 验收

有 Acceptance criteria 时，交付前逐条勾选。
