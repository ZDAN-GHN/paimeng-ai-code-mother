package com.zdan.paimengaicodebackend.service;

import jakarta.servlet.http.HttpServletResponse;

public interface ProjectDownloadService {
    void downloadProjectAsZip(
        String projectPath,
        String downloadFileName,
        HttpServletResponse response
    );
}
