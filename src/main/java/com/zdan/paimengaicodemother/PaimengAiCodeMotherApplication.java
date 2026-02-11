package com.zdan.paimengaicodemother;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 派蒙零代码应用生成后端入口
 *
 * @author LXH
 */
@SpringBootApplication
@MapperScan("com.zdan.paimengaicodemother.mapper")
public class PaimengAiCodeMotherApplication {

    public static void main(String[] args) {
        SpringApplication.run(PaimengAiCodeMotherApplication.class, args);
    }
}
