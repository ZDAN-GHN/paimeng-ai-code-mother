package com.zdan.paimengaicodebackend;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cache.annotation.EnableCaching;

/**
 * 派蒙零代码应用生成后端入口
 *
 * @author LXH
 */
@EnableCaching
@SpringBootApplication
@MapperScan("com.zdan.paimengaicodebackend.mapper")
public class PaimengAiCodeBackendApplication {

    public static void main(String[] args) {
        SpringApplication.run(PaimengAiCodeBackendApplication.class, args);
    }
}
