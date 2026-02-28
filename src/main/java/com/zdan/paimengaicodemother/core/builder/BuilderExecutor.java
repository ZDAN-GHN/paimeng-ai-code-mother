package com.zdan.paimengaicodemother.core.builder;

import cn.hutool.core.io.FileUtil;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import lombok.extern.slf4j.Slf4j;

import java.io.File;

/**
 * 项目构建执行器
 *
 * @author LXH
 */
@Slf4j
public class BuilderExecutor {

    private static final NpmBuilder NPM_BUILDER;

    static {
        NPM_BUILDER = new NpmBuilder();
    }

    /**
     * 异步执行构建
     */
    public static void doBuildAsync(CodeGenTypeEnum codeGenTypeEnum, String sourceDirPath) {
        String projectType = codeGenTypeEnum.getValue();
        // 在单独的线程中执行构建
        Thread.ofVirtual().name(projectType + "-builder-" + System.currentTimeMillis()).start(() -> {
            try {
                doBuild(codeGenTypeEnum, sourceDirPath);
            } catch (Exception e) {
                log.error("failed to build {} project, cause by: {}", projectType, e.getMessage(), e);
            }
        });
    }

    /**
     * 同步执行构建
     *
     * @param codeGenTypeEnum 代码生成类型枚举
     * @param sourceDirPath   构建结果存放目录
     */
    public static File doBuild(CodeGenTypeEnum codeGenTypeEnum, String sourceDirPath) {
        String projectType = codeGenTypeEnum.getValue();
        return switch (codeGenTypeEnum.getBuildType()) {
            case NPM -> {
                boolean buildRes = NPM_BUILDER.buildProject(projectType, sourceDirPath);
                File distDir = new File(sourceDirPath, "dist");
                if (!buildRes || !FileUtil.exist(distDir)) {
                    ThrowUtils.throwForOperation("项目构建失败");
                }
                yield distDir;
            }
            // 没有构建类型就不做处理
            case NONE -> new File(sourceDirPath);
            // 找不到类型就直接抛异常
            default -> {
                log.error("the given buildType is unsupported, buildType: {}", codeGenTypeEnum.getBuildType());
                ThrowUtils.throwForParam("不支持的构建类型");
                yield null;
            }
        };
    }
}
