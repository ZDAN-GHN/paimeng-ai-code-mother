package com.zdan.paimengaicodemother.core.builder;

import cn.hutool.core.util.RuntimeUtil;
import lombok.extern.slf4j.Slf4j;

import java.io.File;
import java.util.concurrent.TimeUnit;

/**
 * vue 项目工程构建器，用于编辑执行 vue 项目代码
 *
 * @author LXH
 */
@Slf4j
public class NpmBuilder {

    /**
     * 异步构建项目（不阻塞主流程）
     *
     * @param projectType 项目类型（vue，react ...）
     * @param projectPath 项目路径
     */
    public void buildProjectAsync(String projectType, String projectPath) {
        // 在单独的线程中执行构建，避免阻塞主流程
        Thread.ofVirtual().name(projectType + "-npm-builder-" + System.currentTimeMillis()).start(() -> {
            try {
                buildProject(projectType, projectPath);
            } catch (Exception e) {
                log.error("failed to build {} project, cause by: {}", projectType, e.getMessage(), e);
            }
        });
    }

    /**
     * 构建 Vue 项目
     *
     * @param projectType 项目类型
     * @param projectPath 项目根目录路径
     * @return 是否构建成功
     */
    public boolean buildProject(String projectType, String projectPath) {
        File projectDir = new File(projectPath);
        if (!projectDir.exists() || !projectDir.isDirectory()) {
            log.error("{} project dir is not existed: {}", projectType, projectPath);
            return false;
        }

        // 检查 package.json 是否存在
        File packageJson = new File(projectDir, "package.json");
        if (!packageJson.exists()) {
            log.error("package.json is not existed: {}", packageJson.getAbsolutePath());
            return false;
        }

        log.info("starting to build {} project: {}", projectType, projectPath);

        // 执行 npm install
        if (!executeNpmInstall(projectDir)) {
            log.error("failed to invoke command [ npm install ]");
            return false;
        }

        // 执行 npm run build
        if (!executeNpmBuild(projectDir)) {
            log.error("failed to invoke command [ npm run build ]");
            return false;
        }

        // 验证 dist 目录是否生成
        File distDir = new File(projectDir, "dist");
        if (!distDir.exists()) {
            log.error("completed to build {} project, but failed to gen dist dir: {}", projectType, distDir.getAbsolutePath());
            return false;
        }

        log.info("completed to build {} project with dist dir: {}", projectType, distDir.getAbsolutePath());
        return true;
    }

    /**
     * 执行 npm install 命令
     */
    private boolean executeNpmInstall(File projectDir) {
        log.info("invoking [ npm install ] ...");
        String command = String.format("%s install", buildCommand("npm"));
        // 5分钟超时
        return executeCommand(projectDir, command, 300);
    }

    /**
     * 执行 npm run build 命令
     */
    private boolean executeNpmBuild(File projectDir) {
        log.info("invoking [ npm run build ] ...");
        String command = String.format("%s run build", buildCommand("npm"));
        // 3分钟超时
        return executeCommand(projectDir, command, 180);
    }

    private String buildCommand(String baseCommand) {
        if (isWindows()) {
            return baseCommand + ".cmd";
        }
        return baseCommand;
    }

    private boolean isWindows() {
        return System.getProperty("os.name").toLowerCase().contains("windows");
    }

    /**
     * 执行命令
     *
     * @param workingDir     工作目录
     * @param command        命令字符串
     * @param timeoutSeconds 超时时间（秒）
     * @return 是否执行成功
     */
    private boolean executeCommand(File workingDir, String command, int timeoutSeconds) {
        try {
            log.info("在目录 {} 中执行命令：{}", workingDir.getAbsolutePath(), command);
            Process process = RuntimeUtil.exec(
                    null,
                    workingDir,
                    // 命令分割为数组
                    command.split("\\s+")
            );
            // 等待进程完成，设置超时
            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                log.error("命令执行超时（{}秒），强制终止进程", timeoutSeconds);
                process.destroyForcibly();
                return false;
            }
            int exitCode = process.exitValue();
            if (exitCode == 0) {
                log.info("命令执行成功：{}", command);
                return true;
            } else {
                log.error("命令执行失败，退出码：{}", exitCode);
                return false;
            }
        } catch (Exception e) {
            log.error("执行命令失败：{}，错误信息：{}", command, e.getMessage());
            return false;
        }
    }
}
