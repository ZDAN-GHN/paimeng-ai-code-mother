package com.zdan.paimengaicodeapp.service;

import jakarta.servlet.http.HttpServletResponse;

/**
 * 项目下载服务
 *
 * @author LXH
 */
public interface ProjectDownloadService {

    /**
     * 下载项目为压缩包
     *
     * @param projectPath
     * @param downloadFileName
     * @param response
     */
    void downloadProjectAsZip(String projectPath, String downloadFileName, HttpServletResponse response);
}
