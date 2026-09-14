package com.zdan.paimengaicodebackend.core.builder;

import cn.hutool.core.util.RuntimeUtil;
import lombok.extern.slf4j.Slf4j;

import java.io.File;
import java.util.concurrent.TimeUnit;


@Slf4j
public class NpmBuilder {


    public void buildProjectAsync(String projectType, String projectPath) {

        Thread.ofVirtual().name(projectType + "-npm-builder-" + System.currentTimeMillis()).start(() -> {
            try {
                buildProject(projectType, projectPath);
            } catch (Exception e) {
                log.error("failed to build {} project, cause by: {}", projectType, e.getMessage(), e);
            }
        });
    }


    public boolean buildProject(String projectType, String projectPath) {
        File projectDir = new File(projectPath);
        if (!projectDir.exists() || !projectDir.isDirectory()) {
            log.error("{} project dir is not existed: {}", projectType, projectPath);
            return false;
        }


        File packageJson = new File(projectDir, "package.json");
        if (!packageJson.exists()) {
            log.error("package.json is not existed: {}", packageJson.getAbsolutePath());
            return false;
        }

        log.info("starting to build {} project: {}", projectType, projectPath);


        if (!executeNpmInstall(projectDir)) {
            log.error("failed to invoke command [ npm install ]");
            return false;
        }


        if (!executeNpmBuild(projectDir)) {
            log.error("failed to invoke command [ npm run build ]");
            return false;
        }


        File distDir = new File(projectDir, "dist");
        if (!distDir.exists()) {
            log.error("completed to build {} project, but failed to gen dist dir: {}", projectType, distDir.getAbsolutePath());
            return false;
        }

        log.info("completed to build {} project with dist dir: {}", projectType, distDir.getAbsolutePath());
        return true;
    }


    private boolean executeNpmInstall(File projectDir) {
        log.info("invoking [ npm install ] ...");
        String command = String.format("%s install", buildCommand("npm"));

        return executeCommand(projectDir, command, 300);
    }


    private boolean executeNpmBuild(File projectDir) {
        log.info("invoking [ npm run build ] ...");
        String command = String.format("%s run build", buildCommand("npm"));

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


    private boolean executeCommand(File workingDir, String command, int timeoutSeconds) {
        try {
            log.info("run command: {} in {}", command, workingDir.getAbsolutePath());
            Process process = RuntimeUtil.exec(
                    null,
                    workingDir,

                    command.split("\\s+")
            );

            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                log.error("命令执行超时（{}秒），强制终止进程", timeoutSeconds);
                process.destroyForcibly();
                return false;
            }
            int exitCode = process.exitValue();
            if (exitCode == 0) {
                log.info("command execution completed: {}", command);
                return true;
            } else {
                log.error("failed to execute command, exit code: {}", exitCode);
                return false;
            }
        } catch (Exception e) {
            log.error("执行命令失败：{}，错误信息：{}", command, e.getMessage());
            return false;
        }
    }
}
