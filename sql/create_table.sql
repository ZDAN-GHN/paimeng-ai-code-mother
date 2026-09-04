create database if not exists paimeng_ai_code_mother;

use paimeng_ai_code_mother;

-- 用户表
create table if not exists user
(
    id           bigint auto_increment comment 'id' primary key,
    userAccount  varchar(256)                           not null comment '账号',
    userPassword varchar(512)                           not null comment '密码',
    userName     varchar(256)                           null comment '用户昵称',
    userAvatar   varchar(1024)                          null comment '用户头像',
    userProfile  varchar(512)                           null comment '用户简介',
    userRole     varchar(256) default 'user'            not null comment '用户角色：user/admin',
    editTime     datetime     default CURRENT_TIMESTAMP not null comment '编辑时间',
    createTime   datetime     default CURRENT_TIMESTAMP not null comment '创建时间',
    updateTime   datetime     default CURRENT_TIMESTAMP not null on update CURRENT_TIMESTAMP comment '更新时间',
    isDelete     tinyint      default 0                 not null comment '是否删除',
    UNIQUE KEY uk_userAccount (userAccount),
    INDEX idx_userName (userName)
) comment '用户' collate = utf8mb4_unicode_ci;

-- 应用表
create table app
(
    id           bigint auto_increment comment 'id' primary key,
    appName      varchar(256)                       null comment '应用名称',
    cover        varchar(512)                       null comment '应用封面',
    initPrompt   text                               null comment '应用初始化的 prompt',
    codeGenType  varchar(64)                        null comment '代码生成类型（枚举）',
    deployKey    varchar(64)                        null comment '部署标识',
    deployedTime datetime                           null comment '部署时间',
    priority     int      default 0                 not null comment '优先级',
    userId       bigint                             not null comment '创建用户id',
    editTime     datetime default CURRENT_TIMESTAMP not null comment '编辑时间',
    createTime   datetime default CURRENT_TIMESTAMP not null comment '创建时间',
    updateTime   datetime default CURRENT_TIMESTAMP not null on update CURRENT_TIMESTAMP comment '更新时间',
    isDelete     tinyint  default 0                 not null comment '是否删除',
    UNIQUE KEY uk_deployKey (deployKey), -- 确保部署标识唯一
    INDEX idx_appName (appName),         -- 提升基于应用名称的查询性能
    INDEX idx_userId (userId)            -- 提升基于用户 ID 的查询性能
) comment '应用' collate = utf8mb4_unicode_ci;

-- 对话历史表
create table chat_history
(
    id          bigint auto_increment comment 'id' primary key,
    message     text                               not null comment '消息',
    messageType varchar(32)                        not null comment 'user/ai',
    appId       bigint                             not null comment '应用id',
    userId      bigint                             not null comment '创建用户id',
    createTime  datetime default CURRENT_TIMESTAMP not null comment '创建时间',
    updateTime  datetime default CURRENT_TIMESTAMP not null on update CURRENT_TIMESTAMP comment '更新时间',
    isDelete    tinyint  default 0                 not null comment '是否删除',
    INDEX idx_appId (appId),                       -- 提升基于应用的查询性能
    INDEX idx_createTime (createTime),             -- 提升基于时间的查询性能
    INDEX idx_appId_createTime (appId, createTime) -- 游标查询核心索引
) comment '对话历史' collate = utf8mb4_unicode_ci;

-- generation_run 表：运行状态持久化通道（checkpoint 等价物，docs/ts_agent/architecture.md §3.2）
-- TS Agent 不直连 MySQL（架构红线），run 状态经 Java 内部 API 读写本表
create table if not exists generation_run
(
    run_id           varchar(64)                                                          not null comment '运行 id（主键，复用现有 runId 语义，UUID）',
    appId            bigint                                                               not null comment '应用 id',
    userId           bigint                                                               not null comment '创建用户 id',
    phase            enum ('interview', 'wireframe_pending', 'wireframe_confirmed', 'coding', 'review', 'building', 'done', 'failed', 'aborted') not null comment '运行阶段（显式枚举，新增 phase = 显式契约变更）',
    context          json                                                                 null comment '运行上下文 JSON（访谈结论/已确认线框路径/plan，XState 快照序列化于此）',
    milestones       json                                                                 null comment '已过里程碑列表 JSON（退款粒度的锚）',
    tokenUsage       json                                                                 null comment 'token 计量 JSON（prompt/completion，定价校准与对账）',
    creditLedgerRef  varchar(128)                                                         null comment '积分台账引用（冻结-结算-退款关联，预留）',
    startedTime      datetime                                                             null comment '开始时间',
    finishedTime     datetime                                                             null comment '结束时间（进入终态的时刻）',
    createTime       datetime default CURRENT_TIMESTAMP                                   not null comment '创建时间',
    updateTime       datetime default CURRENT_TIMESTAMP                                   not null on update CURRENT_TIMESTAMP comment '更新时间',
    isDelete         tinyint  default 0                                                   not null comment '是否删除',
    PRIMARY KEY (run_id),
    INDEX idx_appId_phase (appId, phase), -- 同 app 并发校验 + 断点续传查询（最新非终态 run）核心索引
    INDEX idx_userId (userId)             -- 按用户维度查询
) comment '生成运行（generation_run）' collate = utf8mb4_unicode_ci;