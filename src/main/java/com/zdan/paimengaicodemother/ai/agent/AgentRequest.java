package com.zdan.paimengaicodemother.ai.agent;

import lombok.Data;

import java.util.List;

/**
 * Agent 主通道请求体（泛化自 PythonAgentRequest，Issue #6）
 * 字段与 docs/py_agent/task_plan.md §1.2 一一对应，不得自行改动
 *
 * @author LXH
 */
@Data
public class AgentRequest {

    /**
     * 应用 id
     */
    private Long appId;

    /**
     * 用户 id
     */
    private Long userId;

    /**
     * 用户消息
     */
    private String message;

    /**
     * 代码生成类型，html/multi_file/vue_project
     */
    private String codeGenType;

    /**
     * 本次生成的 runId，用于日志追踪与回调幂等
     */
    private String runId;

    /**
     * 会话标识，固定 app:{appId}
     */
    private String threadId;

    /**
     * 工作区绝对路径（Java 计算传入，Agent 做沙箱校验）
     */
    private String workspacePath;

    /**
     * MySQL 最近 20 条对话，role ∈ user/assistant
     */
    private List<HistoryItem> history;

    /**
     * 对话历史条目
     *
     * @author LXH
     */
    @Data
    public static class HistoryItem {

        /**
         * 角色，user/assistant
         */
        private String role;

        /**
         * 消息内容
         */
        private String content;
    }
}
