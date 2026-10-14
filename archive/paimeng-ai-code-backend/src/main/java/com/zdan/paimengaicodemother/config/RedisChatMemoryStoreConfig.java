package com.zdan.paimengaicodemother.config;

import dev.langchain4j.community.store.memory.chat.redis.RedisChatMemoryStore;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * AI 会话记忆，Redis 配置
 *
 * @author LXH
 */
@Configuration
@ConfigurationProperties(prefix = "spring.data.redis")
@Data
@Slf4j
public class RedisChatMemoryStoreConfig {

    private String host;

    private int port;

    private String password;

    private long ttl;

    @Bean
    public RedisChatMemoryStore redisChatMemoryStoreForCodeGen() {
        final String keyPrefix = "ai:memory:codegen:";
        return RedisChatMemoryStore.builder()
                .host(host)
                .port(port)
                // 密码为空不能加 user
                // .user("default")
                .password(password)
                .ttl(ttl)
                .prefix(keyPrefix)
                .build();
    }
}
