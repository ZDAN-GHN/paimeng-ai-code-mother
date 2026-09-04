package com.zdan.paimengaicodemother.model.dto.run;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;
import java.util.List;

/**
 * Agent 完成回调请求（Java 内部 API，由 TS Agent 在 run 终态调用，Issue #6）
 * runId 走路径参数；写对话历史 + 触发构建均以 runId 幂等（重复回调不重复处理）。
 *
 * @author LXH
 */
@Data
public class AgentCompleteRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    /**
     * 应用 id
     */
    private Long appId;

    /**
     * 创建用户 id（写历史归属）
     */
    private Long userId;

    /**
     * 完成状态，success/failed
     */
    private String status;

    /**
     * 本次对话历史（user/ai 按序落库；success 时含 AI 全文）
     */
    private List<Message> messages;

    /**
     * 工作区绝对路径（success 时构建产物落点）
     */
    private String workspacePath;

    /**
     * 失败时的错误信息（status=failed 时写错误历史）
     */
    private String errorMessage;

    /**
     * 对话历史条目
     *
     * @author LXH
     */
    @Data
    public static class Message implements Serializable {

        @Serial
        private static final long serialVersionUID = 1L;

        /**
         * 消息类型，user/ai
         */
        private String messageType;

        /**
         * 消息内容
         */
        private String content;
    }
}
