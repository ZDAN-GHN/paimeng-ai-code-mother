# 编码规范

> 本文件由 `.codex/hooks/enforce-coding-standards.cjs` 在会话开始时读取并注入上下文。
> 修改本文件即可调整注入给 AI 的规范，无需改动脚本。

## 语言使用规范

**默认使用中文回复**
- 所有解释、分析、计划均使用中文
- 代码、标识符、错误信息保持英文
- 日志片段、堆栈跟踪、CLI 命令保持原文
- 除非用户明确要求，否则即使输入为英文也用中文回复

## 核心原则

### 1. 思考先于编码
- 明确陈述假设，不确定时提问
- 存在多种解释时，列出选项而非静默选择
- 发现更简单的方法时主动说明
- 遇到不清楚的地方立即停下，说明困惑点并询问

### 2. 简洁至上
- 只写解决问题所需的最少代码
- 不添加未被要求的功能
- 单次使用的代码不做抽象
- 不添加未被请求的"灵活性"或"可配置性"
- 不为不可能的场景添加错误处理
- 如果写了 200 行但可以用 50 行完成，重写

**自问：资深工程师会认为这太复杂吗？如果是，简化它。**

### 3. 外科手术式修改
- 只改动必须改的部分
- 不"改进"相邻的代码、注释或格式
- 不重构没有问题的代码
- 匹配现有风格，即使你会用不同方式
- 发现无关的死代码时提及但不删除

**清理自己的痕迹：**
- 移除你的修改导致的未使用导入/变量/函数
- 不删除预先存在的死代码，除非被要求

**测试标准：每一行修改都应该直接追溯到用户请求。**

### 4. 目标驱动执行
将任务转化为可验证的目标：
- "添加验证" → "为无效输入编写测试，然后让它们通过"
- "修复 bug" → "编写重现它的测试，然后让它通过"
- "重构 X" → "确保测试在之前和之后都通过"

对于多步骤任务，陈述简要计划：

```
1. [步骤] → 验证: [检查]
2. [步骤] → 验证: [检查]
3. [步骤] → 验证: [检查]
```

强成功标准让你能够独立循环。弱标准（"让它工作"）需要持续澄清。

## 技术栈约定

### 后端（Spring Boot 3 + MyBatis Flex）
- **包结构**：`com.zdan.paimengaicodemother.*`
  - `ai`：AI 相关逻辑（LangChain4j + LangGraph4j）
  - `controller`：REST API 接口
  - `service`：业务逻辑层
  - `mapper`：数据访问层（MyBatis Flex）
  - `generator`：MyBatis Flex 代码生成器
  - `langgraph4j`：AI 工作流编排
- **代码风格**：遵循阿里巴巴 Java 开发手册
  - 类名 UpperCamelCase；Service 实现类以 `Impl` 结尾
  - 继承异常的类以 `Exception` 结尾；测试类以 `Test`/`Tests` 结尾
  - 禁用 `System.out/err.print`，改用 `@Slf4j` 日志
  - 禁用 `printStackTrace()`，改用 `log.error(msg, e)`
  - Long 字面量用大写 `L`（如 `100L`）
- **配置管理**：
  - `application.yml`：通用配置模板
  - `application-local.yml`：本地敏感配置（含 API keys，已 gitignore，禁止提交）
- **构建工具**：必须使用 Maven Wrapper（`./mvnw` 或 `mvnw.cmd`），不要用全局 `mvn`
- **API 文档**：Knife4j，启动后访问 http://localhost:8123/api/doc.html

### 前端（Vue 3 + TypeScript + Vite）
- **代码风格**：Prettier（`.prettierrc.json`）
  - 无分号（`semi: false`）
  - 单引号（`singleQuote: true`）
  - 100 字符宽度（`printWidth: 100`）
- **主应用路径**：`paimeng-ai-code-mother-frontend/`
- **UI 组件库**：Ant Design Vue；状态管理 Pinia；路由 Vue Router
- **API 类型生成**：运行 `npm run openapi2ts`（需先启动后端）

### 微服务架构（开发中）
- 新架构代码位于 `paimeng-ai-code-mother-microservice/`
- 包含 7 个微服务模块

## 开发流程

### 本地启动
1. 启动 MySQL (localhost:3306) 和 Redis (localhost:6379)
2. 运行 `sql/create_table.sql` 创建数据库
3. 配置 `src/main/resources/application-local.yml`（填入 API keys）
4. 后端：`./mvnw spring-boot:run`
5. 前端：`cd paimeng-ai-code-mother-frontend && npm run dev`

### 常用命令

```bash
# 后端
./mvnw clean install          # 构建项目
./mvnw test                   # 运行所有测试
./mvnw test -Dtest=ClassName  # 运行单个测试
./mvnw spring-boot:run        # 启动应用

# 前端（在 paimeng-ai-code-mother-frontend/ 下）
npm run dev                   # 开发服务器
npm run build                 # 生产构建
npm run type-check            # TypeScript 类型检查
npm run lint                  # ESLint 检查
npm run openapi2ts            # 生成 API 类型
```

### Git 侧校验
`.githooks/pre-commit` 负责机械校验（敏感文件、ESLint、Prettier、Java 命名、阿里规约）。
启用方式：

```bash
git config core.hooksPath .githooks
```

## 提交规范

所有 AI 提交必须包含署名：

```
Co-Authored-By: Codex <codex@openai.com>
```

## 参考文档
- `README.md`：项目概览
- `sql/create_table.sql`：数据库表结构
- `AGENTS.md`：完整的 AI 代理指令

---

**这些规范有效的标志：**
- diff 中更少的不必要修改
- 因过度复杂而导致的重写更少
- 澄清问题在实现之前而非错误之后出现
