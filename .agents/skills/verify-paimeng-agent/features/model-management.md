# 模型与别名配置

管理员在这里配置提供商（OpenAI 兼容网关、上游 baseUrl、密钥）与别名（`codegen.default`、`route.classify`、`speech.transcribe`、`version.summary` 等）。生成、分类、语音转写、版本概述都按别名解析到具体模型。

## Sub-features

- 提供商：名称、协议格式、baseUrl、密钥（直接输入以密文入库，界面与接口都不回显明文）、自定义请求头。
- 别名：指向提供商 + 上游模型名、能力声明、设置项（思考开关/强度、`回传思考内容`、`reasoningField` 等）。
- 别名级设置的隔离：同一提供商挂多个模型时，模型特有开关只影响该别名。
- 可选别名入口：`speech.transcribe`、`version.summary`、`route.classify` 未配置时显示「新增…别名」并预填。
- 保存 / 保存并立即生效（递增刷新批次）；版本冲突时保留表单输入可重载。
- 连通性检测、获取上游模型列表、从下拉选模型名写库。
- 未初始化时只显示初始化提示，不要求密钥。

## How to get to it (user POV)

1. 管理员登录后进入 `/admin/modelManage`。
2. 左侧提供商列表，右侧该提供商的别名表；「编辑」打开弹窗。
3. 保存后生成链路下一轮即用新配置（「保存并立即生效」会递增 refresh epoch）。

## Driving it with Playwright

```bash
node .agents/skills/verify-paimeng-agent/helpers/verify.mjs tests/e2e/model-manage.spec.ts
```

- 现有 10 条用例：未初始化提示、编辑保存、别名级「回传思考内容」+ 语音别名预填、密钥密文、版本冲突、立即生效、普通用户被拒、连通性反馈、下拉选模型名落库、自定义请求头。
- 管理员账号：spec 用 `/api/user/register` 建号后直接在数据库把角色改成 `admin`（见 spec 的 helper），因为注册只产生普通用户。
- 断言落库要查 `model_provider` / `model_alias`，不要只看界面回显；密钥断言是「库里是密文、接口响应不含明文」。
- 静态夹具在 `tests/e2e/support/model-config-fixtures.ts`，改模型配置的用例优先复用它。

## Gotchas

- 有 `name` 的 `Form.Item` 只能有一个控件子节点，外包 `Space`/`div` 会让值静默丢失（仓库里记过一次「六个开关全废」）。新增字段时用 `check:ui` 兜。
- 不要把模型特有设置放到提供商层：同提供商挂多个模型会被连带影响。这类开关属于别名 `settings`。
- 直接输入密钥只在保存瞬间可见；重开弹窗显示占位符是预期，不是丢了。
- 连通性检测会真的发网络请求（探上游 `/models`）：离线环境里失败是环境问题，先看 `run.log` 里的错误码。
- `route.classify` 指向受限地区的模型会返回 “not available in your country”，这种别名不要用来做版本概述的兜底。
