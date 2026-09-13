package com.zdan.paimengaicodeuser;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;

/**
 * 用户微服务启动类
 *
 * @author LXH
 */
@SpringBootApplication
@MapperScan("com.zdan.paimengaicodeuser.mapper")
@ComponentScan("com.zdan")
public class PaimengAiCodeUserApplication {

    public static void main(String[] args) {
        SpringApplication.run(PaimengAiCodeUserApplication.class, args);
     }
}
