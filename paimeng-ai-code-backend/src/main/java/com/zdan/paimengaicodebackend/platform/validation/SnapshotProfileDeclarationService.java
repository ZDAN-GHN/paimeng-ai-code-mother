package com.zdan.paimengaicodebackend.platform.validation;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.platform.entity.ProfileDisposition;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.snapshot.ProfileDispositionService;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import java.io.IOException;
import java.io.InputStream;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.springframework.stereotype.Service;

/** Reads a declaration from the frozen Git tree, never from live workspace or a caller's result claim. */
@Service
class SnapshotProfileDeclarationService {
    private static final String MANIFEST = ".platform/profile-disposition.json";
    private static final long MAX_ARCHIVE_BYTES = 64L * 1024 * 1024;
    private static final int MAX_DECLARATION_BYTES = 65536;
    private static final Set<String> FIELDS = Set.of("disposition", "reason", "diff", "requirementId");

    private final CandidateSnapshotService snapshots;
    private final CandidateGitStore git;
    private final ProfileDispositionService dispositions;
    private final ObjectMapper json;

    SnapshotProfileDeclarationService(CandidateSnapshotService snapshots, CandidateGitStore git,
                                      ProfileDispositionService dispositions, ObjectMapper json) {
        this.snapshots = snapshots;
        this.git = git;
        this.dispositions = dispositions;
        this.json = json;
    }

    ProfileDisposition declare(SnapshotReference ref) {
        if (ref == null) throw rejected();
        ref.require(snapshots);
        byte[] content = readManifest(ref);
        try {
            JsonNode value = json.readTree(content);
            if (value == null || !value.isObject() || value.size() < 2) throw rejected();
            var names = value.fieldNames();
            while (names.hasNext()) if (!FIELDS.contains(names.next())) throw rejected();
            JsonNode status = value.get("disposition");
            JsonNode explanation = value.get("reason");
            if (status == null || !status.isTextual() || explanation == null || !explanation.isTextual()) {
                throw rejected();
            }
            String disposition = status.textValue();
            if (!Set.of("changed", "unchanged", "uncertain").contains(disposition)) throw rejected();
            String reason = explanation.textValue();
            if (reason.isBlank() || reason.length() > 2048) throw rejected();
            String diffJson = null;
            Long requirementId = null;
            if ("changed".equals(disposition)) {
                JsonNode diff = value.get("diff");
                JsonNode requirement = value.get("requirementId");
                if (diff == null || !diff.isObject() || !diff.hasNonNull("candidateProfile")
                    || !diff.get("candidateProfile").isObject() || diff.get("candidateProfile").isEmpty()
                    || !diff.hasNonNull("changes") || !diff.get("changes").isArray()
                    || diff.get("changes").isEmpty() || requirement == null || !requirement.isIntegralNumber()
                    || !requirement.canConvertToLong() || requirement.longValue() <= 0) throw rejected();
                diffJson = json.writeValueAsString(diff);
                requirementId = requirement.longValue();
            } else if (value.has("diff") || value.has("requirementId")) throw rejected();
            return dispositions.record(ref, disposition, diffJson, requirementId, reason);
        } catch (IOException e) {
            throw rejected();
        }
    }

    private byte[] readManifest(SnapshotReference ref) {
        Process archive;
        try {
            archive = git.archive(ref.applicationId(),
                new CandidateGitStore.GitIdentity(ref.commitHash(), ref.treeHash()));
        } catch (IOException e) {
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Snapshot 文件不可恢复", e);
        }
        byte[] content = null;
        try (InputStream bytes = archive.getInputStream(); TarArchiveInputStream tar = new TarArchiveInputStream(bytes)) {
            TarArchiveEntry entry;
            int entries = 0;
            long total = 0;
            while ((entry = tar.getNextEntry()) != null) {
                if (++entries > 4096 || entry.getSize() < 0 || (total += entry.getSize()) > MAX_ARCHIVE_BYTES) {
                    throw rejected();
                }
                if (MANIFEST.equals(entry.getName())) {
                    if (content != null || !entry.isFile() || entry.getSize() > MAX_DECLARATION_BYTES) throw rejected();
                    content = tar.readNBytes((int) entry.getSize());
                    if (content.length != entry.getSize()) throw rejected();
                }
            }
            if (!archive.waitFor(30, TimeUnit.SECONDS) || archive.exitValue() != 0) throw rejected();
            if (content == null || content.length == 0) throw rejected();
            return content;
        } catch (IOException e) {
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Snapshot 申报文件不可恢复", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Snapshot 申报读取中断");
        } finally {
            archive.destroyForcibly();
        }
    }

    private BusinessException rejected() {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Snapshot Profile 申报缺失或不完整");
    }
}
