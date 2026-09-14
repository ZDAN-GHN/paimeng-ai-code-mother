package com.zdan.paimengaicodebackend.manager;

import lombok.extern.slf4j.Slf4j;
import org.openqa.selenium.WebDriver;
import org.springframework.stereotype.Component;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;


import static com.zdan.paimengaicodebackend.utils.WebScreenshotUtils.doScreenshot;
import static com.zdan.paimengaicodebackend.utils.WebScreenshotUtils.initChromeDriver;


@Slf4j
@Component
public class ScreenshotManager {


    private static final WebDriver WEB_DRIVER = initWebDriver();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();


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

            if (WEB_DRIVER == null) {
                log.warn("Chrome 浏览器不可用，跳过截图: {}", url);
                return null;
            }
            WEB_DRIVER.get(url);
            return doScreenshot(WEB_DRIVER);
        }, executor);
    }
}