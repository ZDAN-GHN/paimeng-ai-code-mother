package com.zdan.paimengaicodeapp;

import dev.langchain4j.community.store.embedding.redis.spring.RedisEmbeddingStoreAutoConfiguration;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.context.annotation.ComponentScan;

@SpringBootApplication(exclude = {RedisEmbeddingStoreAutoConfiguration.class})
@MapperScan("com.zdan.paimengaicodeapp.mapper")
@ComponentScan("com.zdan")
@EnableCaching
public class PaimengAiCodeAppApplication {
    public static void main(String[] args) {
        SpringApplication.run(PaimengAiCodeAppApplication.class, args);
    }
}