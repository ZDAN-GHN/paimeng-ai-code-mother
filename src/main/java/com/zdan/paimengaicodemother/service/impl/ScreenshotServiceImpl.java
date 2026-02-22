package com.zdan.paimengaicodemother.service.impl;

import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.StrUtil;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.manager.CosManager;
import com.zdan.paimengaicodemother.manager.ScreenshotManager;
import com.zdan.paimengaicodemother.service.ScreenshotService;
import com.zdan.paimengaicodemother.utils.WebScreenshotUtils;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.File;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

/**
 * 截图服务实现
 *
 * @author LXH
 */
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
        // 参数校验
        ThrowUtils.throwIf(StrUtil.isBlank(webUrl), ErrorCode.PARAMS_ERROR, "截图的网址不能为空");
        log.info("开始生成网页截图，URL：{}", webUrl);
        // 本地截图
        CompletableFuture<String> localScreenshotPathFuture = screenshotManager.takeScreenshot(webUrl);
        String localScreenshotPath = null;
        try {
            localScreenshotPath = localScreenshotPathFuture.get();
            ThrowUtils.throwIf(StrUtil.isBlank(localScreenshotPath), ErrorCode.OPERATION_ERROR, "生成网页截图失败");
            // 上传图片到 COS
            String cosUrl = uploadScreenshotToCos(localScreenshotPath);
            ThrowUtils.throwIf(StrUtil.isBlank(cosUrl), ErrorCode.OPERATION_ERROR, "上传截图到对象存储失败");
            log.info("截图上传成功，URL：{}", cosUrl);
            return cosUrl;
        } catch (Exception e) {
            log.error("failed to take screenshot for site: {} caused by ", webUrl, e);
            ThrowUtils.throwForOperation("生成网页截图失败");
            return null;
        } finally {
            // 清理本地文件
            cleanupLocalFile(localScreenshotPath);
        }
    }

    /**
     * 上传截图到对象存储
     *
     * @param localScreenshotPath 本地截图路径
     * @return 对象存储访问URL，失败返回null
     */
    private String uploadScreenshotToCos(String localScreenshotPath) {
        if (StrUtil.isBlank(localScreenshotPath)) {
            return null;
        }
        File screenshotFile = new File(localScreenshotPath);
        if (!screenshotFile.exists()) {
            log.error("截图文件不存在: {}", localScreenshotPath);
            return null;
        }
        // 生成 COS 对象键
        String fileName = UUID.randomUUID().toString().substring(0, 8) + "_compressed.jpg";
        String cosKey = generateScreenshotKey(fileName);
        return cosManager.uploadFile(cosKey, screenshotFile);
    }

    /**
     * 生成截图的对象存储键
     * 格式：/screenshots/2025/07/31/filename.jpg
     */
    private String generateScreenshotKey(String fileName) {
        String datePath = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyy/MM/dd"));
        return String.format("/screenshots/%s/%s", datePath, fileName);
    }

    /**
     * 清理本地文件
     *
     * @param localFilePath 本地文件路径
     */
    private void cleanupLocalFile(String localFilePath) {
        File localFile = new File(localFilePath);
        if (localFile.exists()) {
            FileUtil.del(localFile);
            log.info("清理本地文件成功: {}", localFilePath);
        }
    }
}
