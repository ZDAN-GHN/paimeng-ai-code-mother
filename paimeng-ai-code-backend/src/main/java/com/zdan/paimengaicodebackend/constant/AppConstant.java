package com.zdan.paimengaicodebackend.constant;

import java.nio.file.Path;

public interface AppConstant {
    Integer GOOD_APP_PRIORITY = 99;

    Integer DEFAULT_APP_PRIORITY = 0;

    String REPOSITORY_ROOT_DIR = Path.of(System.getProperty("user.dir"), "..")
        .normalize()
        .toString();

    String TEMP_ROOT_DIR = Path.of(REPOSITORY_ROOT_DIR, "runtime", "tmp").toString();

    String CODE_OUTPUT_ROOT_DIR = Path.of(TEMP_ROOT_DIR, "code_output").toString();

    String CODE_DEPLOY_ROOT_DIR = Path.of(TEMP_ROOT_DIR, "code_deploy").toString();

    String SCREENSHOT_ROOT_DIR = Path.of(TEMP_ROOT_DIR, "screenshots").toString();

    String CODE_DEPLOY_HOST = "http://localhost";
}
