package com.zdan.paimengaicodebackend.constant;

import java.nio.file.Path;

/**
 * 应用模块系统常量类
 *
 * @author LXH
 */
public interface AppConstant {

    /**
     * 精选应用的优先级
     */
    Integer GOOD_APP_PRIORITY = 99;

    /**
     * 默认应用优先级
     */
    Integer DEFAULT_APP_PRIORITY = 0;

    // region --- 应用部署配置
    /**
     * 应用生成目录
     */
    String REPOSITORY_ROOT_DIR = Path.of(System.getProperty("user.dir"), "..").normalize().toString();

    String TEMP_ROOT_DIR = Path.of(REPOSITORY_ROOT_DIR, "runtime", "tmp").toString();

    String CODE_OUTPUT_ROOT_DIR = Path.of(TEMP_ROOT_DIR, "code_output").toString();

    /**
     * 应用部署目录
     */
    String CODE_DEPLOY_ROOT_DIR = Path.of(TEMP_ROOT_DIR, "code_deploy").toString();

    String SCREENSHOT_ROOT_DIR = Path.of(TEMP_ROOT_DIR, "screenshots").toString();

    /**
     * 应用部署域名
     */
    String CODE_DEPLOY_HOST = "http://localhost";
    // endregion 应用部署配置
}