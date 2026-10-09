# 实现契约

## 数据与 HTTP 边界

所有新实现位于 `refactor-ts-agent/`。旧项目只读，业务 API 不代理旧 Java 服务。公共类型定义在 `src/shared/contracts.ts`。

JSON 成功响应为 `{code:0,data,message:"ok"}`。失败返回业务错误码和对应 HTTP 状态。所有业务 ID 使用十进制字符串，数据库使用 BIGINT。用户、应用和文本聊天历史的新增主键统一由 `src/server/snowflake.ts` 生成，计算及查询使用 `bigint`，不读取数值型 `insertId`。

雪花 ID 保留 MyBatis Flex 1.11.1 的 epoch `1680411660000` 和 41 位时间、5 位数据中心、5 位机器、12 位序列布局。同毫秒序列耗尽后等待真实时钟推进。回拨不超过 5 毫秒时等待恢复，超出容忍值拒绝发号。生成值限定在正的有符号 64 位范围，对外返回十进制字符串。

当前 TS 平台明确使用数据中心 0、机器 0，所有接入同一数据库的进程共享 `ts_snowflake_state` 行锁与已提交下界。发号短事务在业务事务取得行锁前提交，业务失败允许留下空号但不能回退发号状态。此策略替代原 JVM 的 MAC 与 PID 推导，不声称与旧运行进程使用相同节点。独立数据库与未参与协调的旧 Java 发号器不在此唯一性保证内。

`003_snowflake_ids.sql` 取消三个业务主键的自增，仅改变后续插入策略。原 SQL 虽有自增声明，Java 的实体注解会在正常插入前显式赋值；TS 取消自增是防止遗漏赋值的额外约束。已有 ID、关联字段及源码目录保持不变。`ts_message.sequence` 仅用于消息排序，继续自增，生成任务和 UI 消息继续使用原 UUID 标识。

管理 API 挂载 `/api`，校验请求来源。所有 POST 请求需要精确匹配 `APP_ORIGIN` 的 Origin，读取请求体时按实际 UTF-8 字节数限制为 100000 字节。会话使用独立的 `paimeng_ts_session` Cookie，服务端只存令牌摘要。角色读取当前数据库记录，不依赖客户端声明。

## 用户 API

- POST `/api/user/register` 接收 `{userAccount,userPassword,checkPassword}`，返回用户 ID。
- POST `/api/user/login` 返回用户安全视图，并设置会话 Cookie。
- GET `/api/user/get/login` 返回当前用户，POST `/api/user/logout` 撤销当前会话。
- GET `/api/user/get/vo?id=` 返回公开用户视图。GET `/api/user/get?id=` 要求管理员。
- POST `/api/user/list/page/vo`、`/api/user/update` 和 `/api/user/delete` 要求管理员。

用户视图不返回密码摘要。密码使用带盐 scrypt。导入的旧 MD5 摘要只在新库登录成功后升级。删除用户撤销其会话，管理员不能删除当前登录账号。

## 应用 API 与权限

- POST `/api/app/add` 接收 `{initPrompt,codeGenType?}`，返回应用 ID。
- GET `/api/app/get/vo?id=` 返回公开应用信息。
- POST `/api/app/my/list/page/vo` 返回当前用户的应用分页。POST `/api/app/good/list/page/vo` 返回优先级至少 99 的精选应用。
- POST `/api/app/update` 接收 `{id,appName}`，只允许创建者修改名称。
- POST `/api/app/delete` 接收 `{id}`，允许创建者或管理员逻辑删除应用。
- POST `/api/app/deploy` 接收 `{appId}`，GET `/api/app/download/{appId}` 返回 ZIP。这两项只允许创建者。
- 管理员使用 `/api/app/admin/list/page/vo`、`/api/app/admin/get/vo?id=`、`/api/app/admin/update` 和 `/api/app/admin/delete`。

管理员更新可修改名称、封面及优先级。管理员可读取应用消息和任务状态，不能为其他创建者生成、取消、下载或发布。应用编辑页只对创建者开放，其他应用通过管理页处理。

## Agent 消息与任务

POST `/api/app/chat/gen/code` 接收 `{appId,message:UIMessage,requestId:UUID}`。只接受一条用户文本消息，拒绝客户端伪造的系统消息及历史字段。服务端锁定应用后读取权威历史，工具目录绑定当前应用。

- GET `/api/app/messages?appId=` 返回完整 `UIMessage[]`，包括工具输入、输出、状态及文本。
- GET `/api/app/generation?appId=` 返回当前 `Generation` 或 null。
- POST `/api/app/generation/cancel` 接收 `{appId}`，请求取消当前任务。
- GET `/api/chatHistory/app/{appId}?pageSize=10&lastCreateTime=` 返回原文本历史分页。
- POST `/api/chatHistory/admin/list/page/vo` 返回管理员历史分页。

消息、任务及应用历史要求创建者或管理员权限。生成与取消只允许创建者。

任务状态包括 `generating`、`building`、`ready`、`failed` 和 `cancelled`。每个应用只有一个活动任务。同一个请求 UUID 不重复执行。每个用户十分钟内最多提交十次生成请求。

完整助手消息、终态与租约释放在一个事务中完成。取消请求会中止模型与构建，清理完成前保留租约。超时标记失败，失去租约的旧进程不能覆盖新任务。服务重启后，已完成历史直接恢复，异常中断的活动租约到期后由状态读取或下一次提交回收。

React 聊天页使用 AI SDK POST 流式协议。页面加载只展示初始化需求，不自动提交生成。刷新后加载服务端完整历史，工具结果保留。生成 ready 后重新读取应用信息，使用其 `previewUrl`。

## 文件与产物模块

`src/server/workspace.ts` 定义 `WorkspaceApp`，包含应用 ID 和生成类型。它提供工作目录解析，以及列出、读取、写入、精确修改和删除源文件的工具。

`src/server/artifacts.ts` 提供 `buildApp`、`deployApp`、`downloadApp`、`previewUrl`、`deployedUrl` 和 `captureCover`。源码与发布文件位于本目录的 `runtime/`，不写入旧产物。

`src/server/preview.ts` 创建独立静态预览 HTTP 服务，启动入口为 `scripts/preview.ts`。封面及生成页面与管理端使用不同主机名。配置由 `src/server/config.ts` 校验。Vue 构建只在隔离 Docker 环境运行，详细限制见 [产物、构建与预览限制](artifacts.md)。
