package com.zdan.paimengaicodemother.manager;

import lombok.extern.slf4j.Slf4j;
import org.openqa.selenium.WebDriver;
import org.springframework.stereotype.Component;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;


import static com.zdan.paimengaicodemother.utils.WebScreenshotUtils.doScreenshot;
import static com.zdan.paimengaicodemother.utils.WebScreenshotUtils.initChromeDriver;

/**
 * 截图管理器，基于截图工具类做并发控制和优化（并行变串行）
 *
 * @author LXH
 */
@Slf4j
@Component
public class ScreenshotManager {

    // 环境无 Chrome 时降级为 null（截图功能不可用），不阻断后端启动
    private static final WebDriver WEB_DRIVER = initWebDriver();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    /**
     * 初始化 WebDriver，失败时降级为 null
     */
    private static WebDriver initWebDriver() {
        try {
            return initChromeDriver();
        } catch (Exception e) {
            log.warn("初始化 Chrome 浏览器失败，截图功能不可用: {}", e.getMessage());
            return null;
        }
    }

    public CompletableFuture<String> takeScreenshot(String url) {
        return CompletableFuture.supplyAsync(() -> {
            // 无可用驱动时跳过截图
            if (WEB_DRIVER == null) {
                log.warn("Chrome 浏览器不可用，跳过截图: {}", url);
                return null;
            }
            WEB_DRIVER.get(url);
            return doScreenshot(WEB_DRIVER);
        }, executor);
    }
}