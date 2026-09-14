package com.zdan.paimengaicodebackend.service.impl;

import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.StrUtil;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.exception.ThrowUtils;
import com.zdan.paimengaicodebackend.manager.CosManager;
import com.zdan.paimengaicodebackend.manager.ScreenshotManager;
import com.zdan.paimengaicodebackend.service.ScreenshotService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.File;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;


@Service
@Slf4j
public class ScreenshotServiceImpl implements ScreenshotService {

    private final CosManager cosManager;
    private final ScreenshotManager screenshotManager;

    public ScreenshotServiceImpl(CosManager cosManager,
                                 ScreenshotManager screenshotManager) {
        this.cosManager = cosManager;
        this.screenshotManager = screenshotManager;
    }

    @Override
    public String generateAndUploadScreenshot(String webUrl) {

        ThrowUtils.throwIf(StrUtil.isBlank(webUrl), ErrorCode.PARAMS_ERROR, "截图的网址不能为空");
        log.info("开始生成网页截图，URL：{}", webUrl);

        CompletableFuture<String> localScreenshotPathFuture = screenshotManager.takeScreenshot(webUrl);
        String localScreenshotPath = null;
        try {
            localScreenshotPath = localScreenshotPathFuture.get();
            ThrowUtils.throwIf(StrUtil.isBlank(localScreenshotPath), ErrorCode.OPERATION_ERROR, "生成网页截图失败");

            String cosUrl = uploadScreenshotToCos(localScreenshotPath);
            ThrowUtils.throwIf(StrUtil.isBlank(cosUrl), ErrorCode.OPERATION_ERROR, "上传截图到对象存储失败");
            log.info("截图上传成功，URL：{}", cosUrl);
            return cosUrl;
        } catch (Exception e) {
            log.error("failed to take screenshot for site: {} caused by ", webUrl, e);
            ThrowUtils.throwForOperation("生成网页截图失败");
            return null;
        } finally {

            cleanupLocalFile(localScreenshotPath);
        }
    }


    private String uploadScreenshotToCos(String localScreenshotPath) {
        if (StrUtil.isBlank(localScreenshotPath)) {
            return null;
        }
        File screenshotFile = new File(localScreenshotPath);
        if (!screenshotFile.exists()) {
            log.error("截图文件不存在: {}", localScreenshotPath);
            return null;
        }

        String fileName = UUID.randomUUID().toString().substring(0, 8) + "_compressed.jpg";
        String cosKey = generateScreenshotKey(fileName);
        return cosManager.uploadFile(cosKey, screenshotFile);
    }


    private String generateScreenshotKey(String fileName) {
        String datePath = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyy/MM/dd"));
        return String.format("/screenshots/%s/%s", datePath, fileName);
    }


    private void cleanupLocalFile(String localFilePath) {
        File localFile = new File(localFilePath);
        if (localFile.exists()) {
            FileUtil.del(localFile);
            log.info("清理本地文件成功: {}", localFilePath);
        }
    }
}
