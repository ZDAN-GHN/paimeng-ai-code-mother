package com.zdan.paimengaicodemother.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Java 内部 API 配置
 * 供 TS Agent 调用的内部端点（generation_run 读写等）使用，Bearer 服务令牌校验。
 *
 * @author LXH
 */
@Data
@Component
@ConfigurationProperties(prefix = "internal-api")
public class InternalApiProperties {

    /**
     * 内部服务令牌（与 TS Agent 侧 JAVA_INTERNAL_TOKEN 一致；为空时内部端点一律拒绝）
     */
    private String token;
}
