package com.zdan.paimengaicodemother;

import dev.langchain4j.community.store.embedding.redis.spring.RedisEmbeddingStoreAutoConfiguration;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 派蒙零代码应用生成后端入口
 *
 * @author LXH
 */
@SpringBootApplication(exclude = {
        // 排除 Langchain4j-Redis 依赖的默认向量加载配置（目前不需要 rag 知识库）
        RedisEmbeddingStoreAutoConfiguration.class
})
@MapperScan("com.zdan.paimengaicodemother.mapper")
public class PaimengAiCodeMotherApplication {

    public static void main(String[] args) {
        SpringApplication.run(PaimengAiCodeMotherApplication.class, args);
    }
}
