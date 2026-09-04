package com.zdan.paimengaicodemother.ai.agent;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Agent 客户端配置（泛化自 python-agent.*，Issue #6）
 * Java → Agent 主通道（Python Agent / TS Agent 通用）与回调终端信号共用的配置段；
 * 旧键 python-agent.* 作为别名保留（expand-contract，见 AgentLegacyAliasPostProcessor）。
 *
 * @author LXH
 */
@Data
@Component
@ConfigurationProperties(prefix = "agent")
public class AgentProperties {

    /**
     * 是否启用 Agent 链路（false 走旧 Java AI 实现，回退链路行为不变）
     */
    private boolean enabled = false;

    /**
     * Agent 服务地址
     */
    private String baseUrl = "http://localhost:8090";

    /**
     * 内部调用令牌（与 Agent 侧配置一致）
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

    /**
     * 线框生成每用户每日限频（Issue #7，免费 + 独立限频；滚动 24 小时窗口）
     */
    private int wireframeDailyLimit = 10;
}
