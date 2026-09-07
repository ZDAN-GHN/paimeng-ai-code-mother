package com.zdan.paimengaicodemother.langgraph4j.tools;

import com.zdan.paimengaicodemother.langgraph4j.model.ImageResource;
import com.zdan.paimengaicodemother.langgraph4j.model.enums.ImageCategoryEnum;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 全网热词图片搜索工具单元测试
 * 不依赖 Spring 上下文（上下文启动被待恢复的模型 key 与 COS 配置阻塞），直接对本地 SearXNG 实例实测
 *
 * @author LXH
 */
class WebImageSearchToolTest {

    private WebImageSearchTool webImageSearchTool;

    @BeforeEach
    void setUp() {
        webImageSearchTool = new WebImageSearchTool();
        ReflectionTestUtils.setField(webImageSearchTool, "searxngBaseUrl", "http://127.0.0.1:8888");
    }

    @Test
    void testSearchWebImages() {
        // 本地 SearXNG 未启动时跳过测试（仓库根目录 docker compose up -d 后可用）
        Assumptions.assumeTrue(isSearxngUp());
        // 用素材库搜不到的网络热词验证
        List<ImageResource> images = webImageSearchTool.searchWebImages("原神");
        assertNotNull(images);
        assertFalse(images.isEmpty());
        // 验证返回的图片资源
        ImageResource firstImage = images.get(0);
        assertEquals(ImageCategoryEnum.CONTENT, firstImage.getCategory());
        assertNotNull(firstImage.getDescription());
        assertNotNull(firstImage.getUrl());
        assertTrue(firstImage.getUrl().startsWith("http"));
        System.out.println("搜索到 " + images.size() + " 张图片");
        images.forEach(image ->
                System.out.println("图片: " + image.getDescription() + " - " + image.getUrl())
        );
    }

    /**
     * 探测本地 SearXNG 是否可达
     *
     * @return 可达返回 true
     */
    private boolean isSearxngUp() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", 8888), 500);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
