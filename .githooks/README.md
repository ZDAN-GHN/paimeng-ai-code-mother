# 编码规范 Git Hook

```bash
# 启用（仅需一次）
git config core.hooksPath .githooks

# 之后每次提交前自动检查
git commit -m "..."

# 紧急跳过（不推荐）
git commit --no-verify -m "..."
```

## 检查内容

### 1. 敏感文件拦截
- `application-local.yml` / `application-local.yaml`（包含 API keys）
- `.env` 文件

### 2. 前端代码（paimeng-ai-code-mother-frontend/）
- **ESLint**: Vue 3 + TypeScript 代码质量
- **Prettier**: 代码格式（无分号、单引号、100 字符宽度）
- **触发条件**: 暂存 `.ts` / `.tsx` / `.vue` / `.js` / `.mjs` 文件

### 3. 后端 Java 代码
依据**阿里巴巴 Java 开发手册**和项目 IDEA 配置：

#### 命名规范
- 类名必须 `UpperCamelCase` 大驼峰
- Service 实现类以 `Impl` 结尾（如 `UserServiceImpl`）
- 继承 Exception 的类以 `Exception` 结尾
- 测试类以 `Test` 或 `Tests` 结尾

#### 禁用写法（仅检查本次新增代码）
- ❌ `System.out.println()` / `System.err.print()` → ✅ 使用 `@Slf4j` 日志
- ❌ `e.printStackTrace()` → ✅ 使用 `log.error("msg", e)`
- ❌ `100l` → ✅ `100L`（Long 字面量用大写 L）

## 修复提示

```bash
# 前端格式问题
cd paimeng-ai-code-mother-frontend
npm run format  # 自动格式化
npm run lint    # 自动修复 ESLint

# 后端问题
# 使用 IDEA 的阿里巴巴代码规约插件（已在 .idea/inspectionProfiles 配置）
```

## 实现说明
- 文件: `.githooks/pre-commit`
- 环境: Git Bash（Git for Windows 自带）
- 前端工具: 使用 `npx --no-install`，需已 `npm install`
- 后端检查: 纯正则，无需 Maven 编译（速度快）
