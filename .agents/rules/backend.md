# Java 后端

目录：`paimeng-ai-code-backend/`

技术栈：Spring Boot 3.5.4 + Maven + JDK 21

## 职责

- REST API 业务逻辑
- 登录鉴权（签发 JWT）
- 积分/充值
- 聊天历史
- 构建部署

不负责 Agent 编排。

## 分层

```
src/main/java/
└── com.paimeng.aicode/
    ├── controller/   # REST 端点
    ├── service/      # 业务逻辑
    ├── mapper/       # MyBatis
    ├── entity/       # 实体
    └── config/       # 配置
```

保持现有包结构、异常、响应包装。

## JWT

- Java 侧签发短时 JWT
- Agent 侧离线验签

## 内部回调

保留约定：

- Bearer 服务令牌
- runId 幂等

不擅自修改：

- `ts-agent.enabled`
- 端口
- SSE 事件名
- 回调字段

## 验证

```bash
cd paimeng-ai-code-backend
./mvnw compile      # 编译
./mvnw test         # 测试
./mvnw verify       # 完整验证
```

数据库/启动操作遵循 `.agents/skills/project-startup-guardrail/SKILL.md`。
