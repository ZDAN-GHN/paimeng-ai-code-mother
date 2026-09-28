package com.zdan.paimengaicodebackend.platform.snapshot;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;

/** Ingest only regular files and directories from Docker's /workspace archive. */
public final class SnapshotArchive {
    private static final long MAX_BYTES = 64L * 1024 * 1024;
    private static final int MAX_FILES = 4096;
    public static final long MAX_ARCHIVE_BYTES = MAX_BYTES + MAX_FILES * 4096L;
    private static final Set<String> GIT_METADATA = Set.of(
        ".git", ".gitmodules", ".gitattributes", ".gitignore", ".lfsconfig"
    );

    private SnapshotArchive() { }

    public static void extract(InputStream source, Path emptyDirectory) throws IOException {
        Set<String> seen = new HashSet<>();
        long total = 0;
        int files = 0;
        int regularFiles = 0;
        try (CompleteTarArchiveInputStream tar = new CompleteTarArchiveInputStream(new FilterInputStream(source) {
            private long bytes;
            @Override public int read() throws IOException {
                int value = super.read();
                if (value >= 0 && ++bytes > MAX_ARCHIVE_BYTES) throw new IOException("归档超出上限");
                return value;
            }
            @Override public int read(byte[] b, int off, int len) throws IOException {
                int n = super.read(b, off, (int) Math.min(len, Math.max(1, MAX_ARCHIVE_BYTES - bytes + 1)));
                if (n > 0 && (bytes += n) > MAX_ARCHIVE_BYTES) throw new IOException("归档超出上限");
                return n;
            }
            @Override public long skip(long n) throws IOException {
                long skipped = super.skip(Math.min(n, Math.max(1, MAX_ARCHIVE_BYTES - bytes + 1)));
                if ((bytes += skipped) > MAX_ARCHIVE_BYTES) throw new IOException("归档超出上限");
                return skipped;
            }
        })) {
            TarArchiveEntry entry;
            while ((entry = tar.getNextEntry()) != null) {
                String name = entry.getName();
                byte type = entry.getLinkFlag();
                boolean safeType = (entry.isDirectory() && type == TarArchiveEntry.LF_DIR)
                    || (entry.isFile() && (type == TarArchiveEntry.LF_NORMAL
                        || type == TarArchiveEntry.LF_OLDNORM));
                if (name == null || name.startsWith("/") || name.indexOf('\\') >= 0
                    || name.chars().anyMatch(ch -> ch < 32 || ch == 127)
                    || name.length() > 1024 || (entry.getMode() & 07000) != 0
                    || !safeType || entry.isSymbolicLink() || entry.isLink()
                    || entry.isSparse() || entry.isGNUSparse()) {
                    throw invalid();
                }
                String relative = name.startsWith("workspace/") ? name.substring(10) : null;
                if (name.equals("workspace") || name.equals("workspace/")) {
                    if (!entry.isDirectory() || !seen.add("")) throw invalid();
                    continue;
                }
                if (relative == null || relative.isEmpty()) throw invalid();
                String[] segments = relative.split("/", -1);
                int length = segments.length;
                if (entry.isDirectory() && segments[length - 1].isEmpty()) length--;
                if (length == 0) throw invalid();
                Path destination = emptyDirectory;
                for (int i = 0; i < length; i++) {
                    String segment = segments[i];
                    if (segment.isEmpty() || segment.equals(".") || segment.equals("..")
                        || segment.length() > 240 || GIT_METADATA.contains(segment.toLowerCase(Locale.ROOT))) {
                        throw invalid();
                    }
                    destination = destination.resolve(segment);
                }
                if (!seen.add(destination.toString()) || ++files > MAX_FILES || entry.getSize() < 0
                    || entry.getSize() > MAX_BYTES || (total += entry.getSize()) > MAX_BYTES) {
                    throw invalid();
                }
                if (entry.isDirectory()) {
                    Files.createDirectories(destination);
                } else {
                    regularFiles++;
                    Files.createDirectories(destination.getParent());
                    try (var out = Files.newOutputStream(destination, StandardOpenOption.CREATE_NEW)) {
                        byte[] buffer = new byte[8192];
                        long remaining = entry.getSize();
                        while (remaining > 0) {
                            int n = tar.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                            if (n <= 0) throw invalid();
                            out.write(buffer, 0, n);
                            remaining -= n;
                        }
                    }
                    Files.setPosixFilePermissions(destination, Set.of(PosixFilePermission.OWNER_READ,
                        PosixFilePermission.OWNER_WRITE));
                }
            }
            if (!tar.reachedEndOfArchive()) throw invalid();
        }
        if (!seen.contains("") || regularFiles == 0) throw invalid();
    }

    private static final class CompleteTarArchiveInputStream extends TarArchiveInputStream {
        private int endRecords;

        private CompleteTarArchiveInputStream(InputStream input) {
            super(input);
        }

        @Override
        protected byte[] readRecord() throws IOException {
            byte[] record = super.readRecord();
            if (record == null) throw new IOException("Workspace 归档在结束记录前截断");
            return record;
        }

        @Override
        protected boolean isEOFRecord(byte[] record) {
            boolean end = super.isEOFRecord(record);
            if (end && record != null) endRecords++;
            return end;
        }

        private boolean reachedEndOfArchive() {
            return isAtEOF() && endRecords >= 2;
        }
    }

    private static BusinessException invalid() {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Workspace 归档含不安全条目");
    }
}
