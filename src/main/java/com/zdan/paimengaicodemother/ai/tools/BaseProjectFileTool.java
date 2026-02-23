package com.zdan.paimengaicodemother.ai.tools;

/**
 * 工程文件工具基类，
 * 权限修饰符为 protected 不暴露给包外，具体的实现类应被隔离在当前包下
 *
 * @author LXH
 */
public abstract class BaseProjectFileTool extends BaseTool {

    private final String projectType;

    protected BaseProjectFileTool(String projectType) {
        this.projectType = projectType;
    }

    public String projectType() {
        return projectType;
    }

    public String getProjectDirName(Long appId) {
        return projectType + "_" + appId;
    }
}
