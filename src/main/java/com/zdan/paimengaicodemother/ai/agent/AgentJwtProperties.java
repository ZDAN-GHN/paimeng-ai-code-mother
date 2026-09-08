package com.zdan.paimengaicodemother.ai.agent;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Agent JWT 配置
 * Java 登录态换取浏览器直连 TS Agent 的短时 JWT（HS256 共享密钥，Agent 侧离线验签不回查本服务）
 *
 * @author LXH
 */
@Data
@Component
@ConfigurationProperties(prefix = "ts-agent.jwt")
public class AgentJwtProperties {

    /**
     * 签名密钥（与 TS Agent 侧 JWT_SECRET 一致；为空时签发端点拒绝）
     */
    private String secret;

    /**
     * 有效期分钟数
     */
    private long ttlMinutes = 10;
}
