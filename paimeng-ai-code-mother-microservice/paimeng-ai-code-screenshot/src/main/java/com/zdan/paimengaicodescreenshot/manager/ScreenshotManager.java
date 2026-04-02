package com.zdan.paimengaicodescreenshot.manager;

import lombok.extern.slf4j.Slf4j;
import org.openqa.selenium.WebDriver;
import org.springframework.stereotype.Component;

import java.util.concurrent.*;

import static com.zdan.paimengaicodescreenshot.utils.WebScreenshotUtils.doScreenshot;
import static com.zdan.paimengaicodescreenshot.utils.WebScreenshotUtils.initChromeDriver;

/**
 * 截图管理器，基于截图工具类做并发控制和优化（并行变串行）
 *
 * @author LXH
 */
@Component
@Slf4j
public class ScreenshotManager {

    private static final WebDriver WEB_DRIVER = initChromeDriver();
    private final ExecutorService executor;

    {
        executor = new ThreadPoolExecutor(1, 1,
                0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(1000),
                r -> new Thread(r, "screenshot-thread"),
                new ThreadPoolExecutor.DiscardPolicy());
    }

    public CompletableFuture<String> takeScreenshot(String url) {
        return CompletableFuture.supplyAsync(() -> {
            WEB_DRIVER.get(url);
            return doScreenshot(WEB_DRIVER);
        }, executor);
    }
}