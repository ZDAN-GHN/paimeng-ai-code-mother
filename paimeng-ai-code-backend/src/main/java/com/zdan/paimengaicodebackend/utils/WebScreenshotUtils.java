package com.zdan.paimengaicodebackend.utils;

import cn.hutool.core.img.ImgUtil;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.RandomUtil;
import cn.hutool.core.util.StrUtil;
import com.zdan.paimengaicodebackend.constant.AppConstant;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import io.github.bonigarcia.wdm.WebDriverManager;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.OutputType;
import org.openqa.selenium.TakesScreenshot;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.io.File;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;


@Slf4j
public class WebScreenshotUtils {

    private static final WebDriver WEB_DRIVER;



    static {
        final int DEFAULT_WIDTH = 1600;
        final int DEFAULT_HEIGHT = 900;
        WebDriver driver = null;
        try {
            driver = initChromeDriver(DEFAULT_WIDTH, DEFAULT_HEIGHT);
        } catch (Exception e) {
            log.warn("初始化 Chrome 浏览器失败，截图功能不可用: {}", e.getMessage());
        }
        WEB_DRIVER = driver;
    }


    @PreDestroy
    public void destroy() {
        if (WEB_DRIVER != null) {
            WEB_DRIVER.quit();
        }
    }


    public static void cleanupTempFiles() {

        final int MAX_LOOP = 4;
        boolean deleted = false;
        for (int i = 0; i < MAX_LOOP && !deleted; i++) {
            try {
                deleted = FileUtil.clean(AppConstant.SCREENSHOT_ROOT_DIR);
            } catch (Exception e) {
                log.error("删除临时文件失败, 重试次数：{}", i, e);
            }
        }
    }


    public static String saveWebPageScreenshot(String webUrl) {

        if (StrUtil.isBlank(webUrl)) {
            log.error("网页截图失败，url为空");
            return null;
        }

        try {
            String rootPath = AppConstant.SCREENSHOT_ROOT_DIR + File.separator + UUID.randomUUID().toString().substring(0, 8);
            FileUtil.mkdir(rootPath);

            final String IMAGE_SUFFIX = ".png";

            String imageSavePath = rootPath + File.separator + RandomUtil.randomNumbers(5) + IMAGE_SUFFIX;

            WEB_DRIVER.get(webUrl);
            return doScreenshot(WEB_DRIVER, imageSavePath, rootPath);
        } catch (Exception e) {
            log.error("网页截图失败：{}", webUrl, e);
            return null;
        }
    }

    public static String doScreenshot(WebDriver webDriver) {
        String rootPath = AppConstant.SCREENSHOT_ROOT_DIR + File.separator + UUID.randomUUID().toString().substring(0, 8);
        FileUtil.mkdir(rootPath);

        final String IMAGE_SUFFIX = ".png";

        String imageSavePath = rootPath + File.separator + RandomUtil.randomNumbers(5) + IMAGE_SUFFIX;
        return doScreenshot(webDriver, imageSavePath, rootPath);
    }

    public static String doScreenshot(WebDriver webDriver, String imageSavePath, String rootPath) {

        waitForPageLoad(webDriver);

        byte[] screenshotBytes = ((TakesScreenshot) webDriver).getScreenshotAs(OutputType.BYTES);

        saveImage(screenshotBytes, imageSavePath);
        log.info("原始截图保存成功：{}", imageSavePath);

        final String COMPRESS_SUFFIX = "_compressed.jpg";
        String compressedImagePath = rootPath + File.separator + RandomUtil.randomNumbers(5) + COMPRESS_SUFFIX;
        compressImage(imageSavePath, compressedImagePath);
        log.info("压缩图片保存成功：{}", compressedImagePath);

        FileUtil.del(imageSavePath);
        return compressedImagePath;
    }

    public static WebDriver initChromeDriver() {
        final int defaultWidth = 1600;
        final int defaultHeight = 900;
        return initChromeDriver(defaultWidth, defaultHeight);
    }


    private static boolean isChromeAvailable() {

        List<String> candidates = new ArrayList<>(List.of(
                "/usr/bin/google-chrome",
                "/usr/bin/google-chrome-stable",
                "/usr/bin/chromium",
                "/usr/bin/chromium-browser",
                "/opt/google/chrome/chrome",
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
        ));

        String pathEnv = System.getenv("PATH");
        if (StrUtil.isNotBlank(pathEnv)) {
            for (String dir : pathEnv.split(Pattern.quote(File.pathSeparator))) {
                candidates.add(dir + File.separator + "google-chrome");
                candidates.add(dir + File.separator + "chromium");
                candidates.add(dir + File.separator + "chromium-browser");
                if (FileUtil.isWindows()) {
                    candidates.add(dir + File.separator + "chrome.exe");
                }
            }
        }
        for (String path : candidates) {
            if (FileUtil.exist(path) && !FileUtil.isDirectory(path)) {
                return true;
            }
        }
        return false;
    }


    public static WebDriver initChromeDriver(int width, int height) {
        try {

            if (!isChromeAvailable()) {
                log.warn("未检测到 Chrome 浏览器，跳过驱动初始化");
                throw new BusinessException(ErrorCode.SYSTEM_ERROR, "初始化 Chrome 浏览器失败");
            }

            WebDriverManager.chromedriver().setup();

            ChromeOptions options = new ChromeOptions();

            options.addArguments("--headless");

            options.addArguments("--disable-gpu");

            options.addArguments("--no-sandbox");

            options.addArguments("--disable-dev-shm-usage");

            options.addArguments(String.format("--window-size=%d,%d", width, height));

            options.addArguments("--disable-extensions");

            options.addArguments("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36");

            WebDriver driver = new ChromeDriver(options);

            driver.manage().timeouts().pageLoadTimeout(Duration.ofSeconds(30));

            driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10));
            return driver;
        } catch (Exception e) {
            log.error("初始化 Chrome 浏览器失败", e);
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "初始化 Chrome 浏览器失败");
        }
    }


    private static void saveImage(byte[] imageBytes, String imagePath) {
        try {
            FileUtil.writeBytes(imageBytes, imagePath);
        } catch (Exception e) {
            log.error("保存图片失败：{}", imagePath, e);
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "保存图片失败");
        }
    }


    private static void compressImage(String originImagePath, String compressedImagePath) {

        final float COMPRESSION_QUALITY = 0.3f;
        try {
            ImgUtil.compress(
                    FileUtil.file(originImagePath),
                    FileUtil.file(compressedImagePath),
                    COMPRESSION_QUALITY
            );
        } catch (Exception e) {
            log.error("压缩图片失败：{} -> {}", originImagePath, compressedImagePath, e);
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "压缩图片失败");
        }
    }


    private static void waitForPageLoad(WebDriver webDriver) {
        try {

            WebDriverWait wait = new WebDriverWait(webDriver, Duration.ofSeconds(10));

            wait.until(driver -> ((JavascriptExecutor) driver)
                    .executeScript("return document.readyState").
                    equals("complete")
            );

            Thread.sleep(2000);
            log.info("页面加载完成");
        } catch (Exception e) {
            log.error("等待页面加载时出现异常，继续执行截图", e);
        }
    }
}
