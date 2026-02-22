package com.zdan.paimengaicodemother.service;

/**
 * 截图服务
 *
 * @author LXH
 */
public interface ScreenshotService {

    /**
     * 通用的截图服务，可以得到访问地址
     * @param webUrl 网页地址
     * @return 生成的截图的访问 url
     */
    String generateAndUploadScreenshot(String webUrl);
}
