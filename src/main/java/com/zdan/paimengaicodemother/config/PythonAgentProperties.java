package com.zdan.paimengaicodemother.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Python Agent 配置
 * 与 paimeng-ai-code-agent 内部契约对齐（docs/py_agent/task_plan.md §1.1-§1.5）
 *
 * @author LXH
 */
@Data
@Component
@ConfigurationProperties(prefix = "python-agent")
public class PythonAgentProperties {

    /**
     * 是否启用 Python Agent 链路（false 走旧 Java AI 实现）
     */
    private boolean enabled = false;

    /**
     * Python Agent 服务地址
     */
    private String baseUrl = "http://localhost:8090";

    /**
     * 内部调用令牌（与 Python 侧 PYTHON_AGENT_TOKEN 一致）
     */
    private String token;

    /**
     * 主通道连接超时，毫秒
     */
    private long connectTimeoutMs = 3000;

    /**
     * 主通道读超时，毫秒（期间既无事件也无回调则判定失败）
     */
    private long readTimeoutMs = 300000;

    /**
     * 回调等待超时，毫秒（主通道结束后等待完成回调的最长时间）
     */
    private long callbackTimeoutMs = 60000;
}
