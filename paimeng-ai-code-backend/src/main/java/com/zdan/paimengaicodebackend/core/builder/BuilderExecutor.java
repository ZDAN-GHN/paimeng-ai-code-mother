package com.zdan.paimengaicodebackend.core.builder;

import cn.hutool.core.io.FileUtil;
import com.zdan.paimengaicodebackend.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodebackend.exception.ThrowUtils;
import java.io.File;
import lombok.extern.slf4j.Slf4j;

@Slf4j
public class BuilderExecutor {

    private static final NpmBuilder NPM_BUILDER;

    static {
        NPM_BUILDER = new NpmBuilder();
    }

    public static void doBuildAsync(CodeGenTypeEnum codeGenTypeEnum, String sourceDirPath) {
        String projectType = codeGenTypeEnum.getValue();

        Thread.ofVirtual()
            .name(projectType + "-builder-" + System.currentTimeMillis())
            .start(() -> {
                try {
                    doBuild(codeGenTypeEnum, sourceDirPath);
                } catch (Exception e) {
                    log.error(
                        "failed to build {} project, cause by: {}",
                        projectType,
                        e.getMessage(),
                        e
                    );
                }
            });
    }

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
            case NONE -> new File(sourceDirPath);
            default -> {
                log.error(
                    "the given buildType is unsupported, buildType: {}",
                    codeGenTypeEnum.getBuildType()
                );
                ThrowUtils.throwForParam("不支持的构建类型");
                yield null;
            }
        };
    }
}
