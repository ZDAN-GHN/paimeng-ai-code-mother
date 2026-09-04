package com.zdan.paimengaicodemother.ai.agent;

import lombok.Data;

/**
 * Agent 完成回调请求体（泛化自 PythonAgentCallbackRequest，Issue #6）
 * 字段与 docs/py_agent/task_plan.md §1.4 一一对应，不得自行改动；
 * status 仅接受 success/failed（非法值返回 400，A9）
 *
 * @author LXH
 */
@Data
public class AgentCallbackRequest {

    /**
     * 本次生成的 runId（幂等键）
     */
    private String runId;

    /**
     * 应用 id
     */
    private Long appId;

    /**
     * 代码生成类型，html/multi_file/vue_project
     */
    private String codeGenType;

    /**
     * 完成状态，success/failed
     */
    private String status;

    /**
     * 失败时的错误信息
     */
    private String message;

    /**
     * 工作区绝对路径
     */
    private String workspacePath;
}
