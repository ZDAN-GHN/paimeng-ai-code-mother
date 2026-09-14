package com.zdan.paimengaicodebackend.utils;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class WebScreenshotUtilsTest {

    @Test
    void saveWebPageScreenshot() {
        String webPageScreenshot = WebScreenshotUtils.saveWebPageScreenshot(
            "https://www.baidu.com"
        );
        Assertions.assertNotNull(webPageScreenshot);
    }
}
