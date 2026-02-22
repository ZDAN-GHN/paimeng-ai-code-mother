package com.zdan.paimengaicodemother.utils;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * @author LXH
 */
class WebScreenshotUtilsTest {

    @Test
    void saveWebPageScreenshot() {
        String webPageScreenshot = WebScreenshotUtils.saveWebPageScreenshot("https://www.baidu.com");
        Assertions.assertNotNull(webPageScreenshot);
    }
}