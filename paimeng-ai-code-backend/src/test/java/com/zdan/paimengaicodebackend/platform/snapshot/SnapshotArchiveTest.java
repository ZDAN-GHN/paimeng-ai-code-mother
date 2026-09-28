package com.zdan.paimengaicodebackend.platform.snapshot;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SnapshotArchiveTest {
    @TempDir Path directory;

    @Test
    void acceptsRegularWorkspaceFilesAndCreatesNoExecutable() throws IOException {
        byte[] archive = archive("workspace/project/src.txt", TarArchiveEntry.LF_NORMAL, "source");
        SnapshotArchive.extract(new ByteArrayInputStream(archive), directory);
        assertEquals("source", Files.readString(directory.resolve("project/src.txt")));
        assertTrue(!Files.isExecutable(directory.resolve("project/src.txt")));
    }

    @Test
    void rejectsEscapeLinkAndGitControlFiles() throws IOException {
        for (String name : new String[] {"workspace/../escape", "workspace/.git/config",
            "workspace/project/.gitattributes", "/workspace/absolute", "workspace/a\\b"}) {
            byte[] payload = archive(name, TarArchiveEntry.LF_NORMAL, "bad");
            if (name.startsWith("/")) {
                try (TarArchiveInputStream raw = new TarArchiveInputStream(new ByteArrayInputStream(payload))) {
                    raw.getNextEntry(); // workspace/
                    assertEquals(name, raw.getNextEntry().getName());
                }
            }
            assertThrows(BusinessException.class, () -> SnapshotArchive.extract(
                new ByteArrayInputStream(payload), directory
            ), name);
        }
        assertThrows(BusinessException.class, () -> SnapshotArchive.extract(
            new ByteArrayInputStream(archive("workspace/link", TarArchiveEntry.LF_SYMLINK, "")), directory
        ));
    }

    @Test
    void rejectsDirectoryOnlyArchive() throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (TarArchiveOutputStream tar = new TarArchiveOutputStream(bytes)) {
            TarArchiveEntry root = new TarArchiveEntry("workspace/");
            tar.putArchiveEntry(root);
            tar.closeArchiveEntry();
        }
        assertThrows(BusinessException.class, () -> SnapshotArchive.extract(
            new ByteArrayInputStream(bytes.toByteArray()), directory));
    }

    @Test
    void rejectsHardLinksSpecialFilesAndSetuidModes() throws IOException {
        for (byte type : new byte[] {TarArchiveEntry.LF_LINK, TarArchiveEntry.LF_FIFO,
            TarArchiveEntry.LF_CHR}) {
            assertThrows(BusinessException.class, () -> SnapshotArchive.extract(
                new ByteArrayInputStream(archive("workspace/unsafe", type, "")), directory),
                "tar type=" + (char) type);
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (TarArchiveOutputStream tar = new TarArchiveOutputStream(bytes)) {
            TarArchiveEntry root = new TarArchiveEntry("workspace/");
            tar.putArchiveEntry(root);
            tar.closeArchiveEntry();
            TarArchiveEntry unsafe = new TarArchiveEntry("workspace/executable");
            unsafe.setMode(04755);
            tar.putArchiveEntry(unsafe);
            tar.closeArchiveEntry();
        }
        assertThrows(BusinessException.class, () -> SnapshotArchive.extract(
            new ByteArrayInputStream(bytes.toByteArray()), directory));
    }

    @Test
    void rejectsDeclaredSizeOverLimitBeforeReadingFileBody() throws IOException {
        TarArchiveEntry root = new TarArchiveEntry("workspace/");
        TarArchiveEntry oversized = new TarArchiveEntry("workspace/oversized");
        oversized.setSize(64L * 1024 * 1024 + 1);
        byte[] rootHeader = new byte[512];
        byte[] fileHeader = new byte[512];
        root.writeEntryHeader(rootHeader);
        oversized.writeEntryHeader(fileHeader);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bytes.write(rootHeader);
        bytes.write(fileHeader);
        bytes.write(new byte[1024]);
        assertThrows(BusinessException.class, () -> SnapshotArchive.extract(
            new ByteArrayInputStream(bytes.toByteArray()), directory));
    }

    @Test
    void rejectsDuplicateFiles() throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (TarArchiveOutputStream tar = new TarArchiveOutputStream(bytes)) {
            TarArchiveEntry root = new TarArchiveEntry("workspace/");
            tar.putArchiveEntry(root);
            tar.closeArchiveEntry();
            for (int i = 0; i < 2; i++) {
                TarArchiveEntry entry = new TarArchiveEntry("workspace/a");
                tar.putArchiveEntry(entry);
                tar.closeArchiveEntry();
            }
        }
        assertThrows(BusinessException.class, () -> SnapshotArchive.extract(
            new ByteArrayInputStream(bytes.toByteArray()), directory));
    }

    @Test
    void rejectsMissingOrIncompleteTarEndRecordsAndTruncatedFileBody() throws IOException {
        byte[] complete = archive("workspace/source.txt", TarArchiveEntry.LF_NORMAL, "source");
        int firstEndRecord = 512 + 512 + 512;
        for (int length : new int[] {firstEndRecord, firstEndRecord + 256,
            firstEndRecord + 512, 512 + 512 + 3}) {
            assertThrows(IOException.class, () -> SnapshotArchive.extract(
                new ByteArrayInputStream(Arrays.copyOf(complete, length)), directory),
                "truncated at " + length);
        }
    }

    private byte[] archive(String name, byte type, String content) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (TarArchiveOutputStream tar = new TarArchiveOutputStream(bytes)) {
            TarArchiveEntry root = new TarArchiveEntry("workspace/");
            tar.putArchiveEntry(root);
            tar.closeArchiveEntry();
            TarArchiveEntry entry = new TarArchiveEntry(name, type, true);
            byte[] payload = content.getBytes(StandardCharsets.UTF_8);
            entry.setSize(payload.length);
            tar.putArchiveEntry(entry);
            tar.write(payload);
            tar.closeArchiveEntry();
        }
        return bytes.toByteArray();
    }
}
