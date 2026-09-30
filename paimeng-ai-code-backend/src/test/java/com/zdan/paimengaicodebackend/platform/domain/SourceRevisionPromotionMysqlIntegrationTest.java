package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import com.zdan.paimengaicodebackend.platform.validation.PlatformValidationQueueService;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/** Requires a separately provisioned V13 schema in a disposable isolated MySQL database. */
@EnabledIfEnvironmentVariable(named = "ISSUE79_T6_MYSQL_URL", matches = ".+")
@SpringBootTest(properties = {
    "spring.datasource.url=${ISSUE79_T6_MYSQL_URL}",
    "spring.datasource.username=${ISSUE79_T6_MYSQL_USER}",
    "spring.datasource.password=${ISSUE79_T6_MYSQL_PASSWORD}",
    "spring.flyway.enabled=false"
})
class SourceRevisionPromotionMysqlIntegrationTest {
    @Autowired private JdbcTemplate jdbc;
    @Autowired private SourceRevisionPromotionService service;
    @MockitoBean private AppMapper apps;
    @MockitoBean private CandidateSnapshotService snapshots;
    @MockitoBean private CandidateGitStore git;
    @MockitoBean private PlatformTaskTransitionService transitions;
    @MockitoBean private PlatformValidationQueueService validationQueue;

    @Test
    void finalCasFailureRollsBackValidatedTaskProfileAndRevision() throws Exception {
        String url = System.getenv("ISSUE79_T6_MYSQL_URL");
        org.junit.jupiter.api.Assertions.assertTrue(url.matches(
            "jdbc:mysql://127\\.0\\.0\\.1:(?!3306)\\d+/issue79_t6_[a-zA-Z0-9_]+"));
        assertEquals(latestMigrationVersion(), jdbc.queryForObject(
            "SELECT version FROM flyway_schema_history WHERE success = 1 "
                + "ORDER BY installed_rank DESC LIMIT 1", String.class),
            "隔离库必须完整迁移到仓库中的最新版本");
        assertEquals(0, jdbc.queryForObject(
            "SELECT COUNT(*) FROM flyway_schema_history WHERE success = 0", Integer.class),
            "隔离库不得存在迁移失败记录");
        long app = (UUID.randomUUID().getMostSignificantBits() & Long.MAX_VALUE) / 10;
        long task = app + 1;
        String run = "t6-" + UUID.randomUUID();
        String attempt = UUID.randomUUID().toString();
        String baselineJson = "{\"schemaVersion\":1}";
        String baseline = CandidateGitStore.sha256(baselineJson);
        String commit = "b".repeat(40), tree = "c".repeat(40);
        jdbc.update("INSERT INTO app (id,userId,appName,lifecycleStatus) VALUES (?,1,'t6','ACTIVE')", app);
        jdbc.update("INSERT INTO platform_requirement (id,appId,kind,originalText) VALUES (?,?,?,?)",
            app + 2, app, "OWNER", "synthetic");
        jdbc.update("INSERT INTO platform_trusted_profile_version (id,appId,versionNumber,profileJson) "
            + "VALUES (?,?,1,'{}')", app + 3, app);
        jdbc.update("INSERT INTO platform_task (id,appId,requirementId,state,baselineJson,baseProfileVersion) "
            + "VALUES (?,?,?,'EXECUTING',?,?)", task, app, app + 2, baselineJson, app + 3);
        jdbc.update("INSERT INTO platform_run (id,appId,taskId,state,attemptNumber) "
            + "VALUES (?,?,?,'SUCCEEDED',1)", run, app, task);
        jdbc.update("INSERT INTO platform_candidate_source_snapshot "
            + "(runId,appId,taskId,requestId,fenceToken,baselineHash,status,commitHash,treeHash) "
            + "VALUES (?,?,?,'freeze',1,?,'READY',?,?)", run, app, task, baseline, commit, tree);
        jdbc.update("INSERT INTO platform_profile_disposition "
            + "(runId,appId,taskId,baselineHash,commitHash,treeHash,disposition,diffJson,requirementId,reason) "
            + "VALUES (?,?,?,?,?,?,'changed',?,?,?)", run, app, task, baseline, commit, tree,
            "{\"candidateProfile\":{\"name\":\"new\"},\"changes\":[{\"field\":\"name\"}]}", app + 2, "requested");
        String[] categories = {"ENGINEERING", "DATABASE", "RUNTIME", "TASK_ACCEPTANCE"};
        Map<String, byte[]> artifacts = new HashMap<>();
        for (int i = 0; i < categories.length; i++) {
            String payload = "{\"schemaVersion\":1,\"category\":\"" + categories[i]
                + "\",\"status\":\"PASS\",\"reasonCode\":\"PASS\"}";
            String digest = CandidateGitStore.sha256(payload);
            artifacts.put(digest, payload.getBytes(StandardCharsets.UTF_8));
            jdbc.update("INSERT INTO platform_validation_evidence (id,appId,taskId,runId,baselineHash,"
                + "commitHash,treeHash,category,result,payloadJson,payloadSha256,artifactRef,"
                + "artifactCommitHash,artifactSha256,idempotencyKey,issuer,attemptId) "
                + "VALUES (?,?,?,?,?,?,?,?,'PASS',?,SHA2(?,256),?,?,?,?,?,?)", app + 4 + i, app, task, run,
                baseline, commit, tree, categories[i], payload, payload,
                "refs/evidence/" + "a".repeat(64), "d".repeat(40), digest,
                attempt + ":" + categories[i], "PLATFORM_VALIDATOR_V1", attempt);
        }
        SnapshotReference ref = new SnapshotReference(app, task, run, baseline, null, commit, tree);
        CandidateSourceSnapshot snapshot = new CandidateSourceSnapshot();
        snapshot.setRunId(run); snapshot.setApplicationId(app); snapshot.setTaskId(task);
        snapshot.setBaselineHash(baseline); snapshot.setCommitHash(commit); snapshot.setTreeHash(tree);
        snapshot.setStatus("READY");
        App application = new App();
        application.setId(app); application.setIsDelete(0); application.setLifecycleStatus("ACTIVE");
        when(apps.lockForPromotion(app)).thenReturn(app);
        when(apps.selectOneById(app)).thenReturn(application);
        when(apps.updateByQuery(any(App.class), eq(true), any())).thenReturn(0);
        when(snapshots.requireReady(app, run)).thenReturn(snapshot);
        when(validationQueue.requirePassed(ref)).thenReturn(attempt);
        when(git.readEvidence(any(), any())).thenAnswer(invocation -> {
            CandidateGitStore.ArtifactReference reference = invocation.getArgument(1);
            return artifacts.get(reference.sha256());
        });
        doAnswer(invocation -> {
            jdbc.update("UPDATE platform_task SET state = 'VALIDATED' WHERE id = ?", task);
            return null;
        }).when(transitions).transition(eq(task), any(), any(), any(), any(), any(), any(), any());

        assertThrows(BusinessException.class, () -> service.promote(ref));
        assertEquals("EXECUTING", jdbc.queryForObject("SELECT state FROM platform_task WHERE id = ?",
            String.class, task));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM platform_source_revision WHERE runId = ?",
            Integer.class, run));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM platform_trusted_profile_version WHERE appId = ?",
            Integer.class, app));
    }

    /** 仓库中最新的迁移版本号，避免测试硬编码版本而随迁移漂移 */
    private static String latestMigrationVersion() throws Exception {
        int highest;
        try (java.util.stream.Stream<java.nio.file.Path> names = java.nio.file.Files.list(
                java.nio.file.Path.of(PlatformTask.class
                    .getResource("/db/migration").toURI()))) {
            highest = names.map(path -> path.getFileName().toString())
                .map(name -> java.util.regex.Pattern.compile("^V(\\d+)__").matcher(name))
                .filter(java.util.regex.Matcher::find)
                .mapToInt(match -> Integer.parseInt(match.group(1)))
                .max().orElseThrow();
        }
        return String.valueOf(highest);
    }
}
