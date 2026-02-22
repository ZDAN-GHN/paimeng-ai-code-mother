package com.zdan.paimengaicodemother.manager;

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
@Component
public class ScreenshotManager {

    private static final WebDriver webDriver = initChromeDriver();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    public CompletableFuture<String> takeScreenshot(String url) {
        return CompletableFuture.supplyAsync(() -> {
            webDriver.get(url);
            return doScreenshot(webDriver);
        }, executor);
    }
}