package com.zdan.paimengaicodebackend.service.impl;

import cn.hutool.core.util.StrUtil;
import cn.hutool.core.util.ZipUtil;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.exception.ThrowUtils;
import com.zdan.paimengaicodebackend.service.ProjectDownloadService;
import jakarta.servlet.http.HttpServletResponse;
import java.io.File;
import java.io.FileFilter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Set;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

@Service
@Slf4j
public class ProjectDownloadServiceImpl implements ProjectDownloadService {

    private static final Set<String> IGNORED_NAMES = Set.of(
        "node_modules",
        ".git",
        "dist",
        "build",
        ".DS_Store",
        ".env",
        "target",
        ".mvn",
        ".idea",
        ".vscode"
    );

    private static final Set<String> IGNORED_EXTENSIONS = Set.of(".log", ".tmp", ".cache");

    @Override
    public void downloadProjectAsZip(
        String projectPath,
        String downloadFileName,
        HttpServletResponse response
    ) {
        ThrowUtils.throwIf(
            StrUtil.isBlank(projectPath),
            ErrorCode.PARAMS_ERROR,
            "项目路径不能为空"
        );
        ThrowUtils.throwIf(
            StrUtil.isBlank(downloadFileName),
            ErrorCode.PARAMS_ERROR,
            "下载文件名不能为空"
        );
        File projectDir = new File(projectPath);
        ThrowUtils.throwIf(!projectDir.exists(), ErrorCode.PARAMS_ERROR, "项目路径不存在");
        ThrowUtils.throwIf(
            !projectDir.isDirectory(),
            ErrorCode.PARAMS_ERROR,
            "项目路径不是一个目录"
        );
        log.info("开始打包下载项目: {} -> {}.zip", projectPath, downloadFileName);

        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType("application/zip");
        response.addHeader(
            "Content-Disposition",
            String.format("attachment; filename=\"%s.zip\"", downloadFileName)
        );

        FileFilter filter = file -> isPathAllowed(projectDir.toPath(), file.toPath());

        try {
            ZipUtil.zip(
                response.getOutputStream(),
                StandardCharsets.UTF_8,
                false,
                filter,
                projectDir
            );
            log.info("打包下载项目成功: {} -> {}.zip", projectPath, downloadFileName);
        } catch (IOException e) {
            log.error("打包下载项目失败", e);
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "打包下载项目失败");
        }
    }

    private boolean isPathAllowed(Path projectRoot, Path fullPath) {
        Path relativePath = projectRoot.relativize(fullPath);

        for (Path part : relativePath) {
            String partName = part.toString();

            if (IGNORED_NAMES.contains(partName)) {
                return false;
            }

            if (IGNORED_EXTENSIONS.stream().anyMatch(ext -> partName.toLowerCase().endsWith(ext))) {
                return false;
            }
        }
        return true;
    }
}
