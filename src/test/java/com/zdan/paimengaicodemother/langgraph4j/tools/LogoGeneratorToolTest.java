package com.zdan.paimengaicodemother.langgraph4j.tools;

import cn.hutool.core.util.StrUtil;
import com.zdan.paimengaicodemother.langgraph4j.model.ImageResource;
import com.zdan.paimengaicodemother.langgraph4j.model.enums.ImageCategoryEnum;
import jakarta.annotation.Resource;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.env.Environment;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
class LogoGeneratorToolTest {

    @Resource
    private LogoGeneratorTool logoGeneratorTool;

    @Resource
    private Environment environment;

    @Test
    void testGenerateLogos() {
        // 未配置硅基流动 api key 时跳过，避免无 key 的必然失败（配置后本测试即真实调用）
        Assumptions.assumeTrue(StrUtil.isNotBlank(environment.getProperty("siliconflow.api-key")));
        List<ImageResource> logos = logoGeneratorTool.generateLogos("技术公司现代简约风格Logo");
        assertNotNull(logos);
        ImageResource firstLogo = logos.getFirst();
        assertEquals(ImageCategoryEnum.LOGO, firstLogo.getCategory());
        assertNotNull(firstLogo.getDescription());
        assertNotNull(firstLogo.getUrl());
        logos.forEach(logo ->
                System.out.println("Logo: " + logo.getDescription() + " - " + logo.getUrl())
        );
    }
}