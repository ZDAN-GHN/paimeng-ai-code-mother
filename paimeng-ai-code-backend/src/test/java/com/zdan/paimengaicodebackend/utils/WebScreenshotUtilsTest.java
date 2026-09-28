package com.zdan.paimengaicodebackend.utils;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WebScreenshotUtilsTest {

    @Test
    void saveWebPageScreenshot(@TempDir Path pageDir) throws IOException {
        Path page = pageDir.resolve("index.html");
        Files.writeString(page, "<!doctype html><html><body><h1>Screenshot test</h1></body></html>");
        String screenshot = WebScreenshotUtils.saveWebPageScreenshot(page.toUri().toString());
        assertNotNull(screenshot);
        Path image = Path.of(screenshot);
        try {
            assertTrue(Files.isRegularFile(image));
            assertTrue(Files.size(image) > 0);
        } finally {
            Files.deleteIfExists(image);
            Files.deleteIfExists(image.getParent());
        }
    }
}
