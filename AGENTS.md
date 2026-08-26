# Agent Instructions

## Local Setup
1. 启动依赖服务：MySQL (localhost:3306) 和 Redis (localhost:6379)
2. 创建数据库：运行 `sql/create_table.sql`
3. 配置 `src/main/resources/application-local.yml`（参考 `application.yml`，需填入 API keys）
4. 前端配置已包含在 `paimeng-ai-code-mother-frontend/.env.development`

## Package Manager
- **Maven Wrapper**：`./mvnw clean install`（Windows 使用 `mvnw.cmd`）
- **前端 (npm)**：在 `paimeng-ai-code-mother-frontend/` 目录使用 `npm install`

## Commands
| Task | Command |
|------|---------|
| 运行后端 | `./mvnw spring-boot:run` |
| 运行全部测试 | `./mvnw test` |
| 运行单个测试 | `./mvnw test -Dtest=类名` |
| API 文档 | 启动后访问 `http://localhost:8123/api/doc.html` |
| 前端开发服务器 | `cd paimeng-ai-code-mother-frontend && npm run dev` |
| 前端构建 | `cd paimeng-ai-code-mother-frontend && npm run build` |
| 前端类型检查 | `cd paimeng-ai-code-mother-frontend && npm run type-check` |
| 前端代码检查 | `cd paimeng-ai-code-mother-frontend && npm run lint` |
| 生成 API 类型 | `cd paimeng-ai-code-mother-frontend && npm run openapi2ts`（需先启动后端） |

## External References
| Need | File |
|------|------|
| 项目概览 | `README.md` |
| 数据库表结构 | `sql/create_table.sql` |

## Key Conventions
- **Java 包结构**：`com.zdan.paimengaicodemother.*`，主要模块包括 `ai`（AI 相关）、`controller`（接口）、`service`（业务逻辑）、`mapper`（数据访问）
- **后端代码风格**：遵循阿里巴巴 Java 开发手册
- **前端代码风格**：Prettier 配置为无分号、单引号、100 字符宽度
- **前端路径**：主应用前端在 `paimeng-ai-code-mother-frontend/`
- **微服务重构**：新架构代码位于 `paimeng-ai-code-mother-microservice/` 目录，包含 7 个微服务模块
- **MyBatis Flex 代码生成**：使用 `com.zdan.paimengaicodemother.generator` 包中的生成器，生成的 mapper 文件位于 `src/main/resources/mapper/`
- **AI 框架**：使用 LangChain4j 和 LangGraph4j 构建 AI 工作流，主要逻辑在 `ai` 和 `langgraph4j` 包中
- **配置文件**：`application-local.yml` 包含敏感信息，已 gitignore，不要提交到版本控制

## Commit Attribution
AI commits MUST include:
```
Co-Authored-By: Codex <codex@openai.com>
```
