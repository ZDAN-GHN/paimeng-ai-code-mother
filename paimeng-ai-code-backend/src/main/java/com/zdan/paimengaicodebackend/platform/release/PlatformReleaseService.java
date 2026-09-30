package com.zdan.paimengaicodebackend.platform.release;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformDeploymentMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformReleaseMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentProperties;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentStage;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentState;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskLifecycleService;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRelease;
import com.zdan.paimengaicodebackend.platform.entity.SourceRevision;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import java.util.Objects;
import java.util.Optional;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 固定 Release 的唯一创建入口（Issue #81 / T-09）
 *
 * <p>CT-004 把「晋升 SourceRevision」与「创建 Release」列为同一契约的两个输出，因此本服务
 * 永远由 {@code SourceRevisionPromotionService} 在同一个事务里调用：晋升成功却没留下 Release
 * 是一个不该存在的中间态——那样 Owner 会看到「验证已通过」却永远等不到上线。
 *
 * <p>AD-011：只有「该 Application 的第一个 validated 版本」才自动发布。已有历史 Release 时
 * 本服务什么都不做——后续版本必须等 Owner 以业务语言确认，那是另一个 Ticket 的范围。
 * 提前静默退出而不是抛错，是因为对后续版本而言「没有自动发布」是正确的正常路径，
 * 不是失败。
 */
@Slf4j
@Service
public class PlatformReleaseService {

    /**
     * 首次发布的对外结果。
     *
     * @param releaseId    被固定的 Release 标识
     * @param deploymentId 等待执行的 Deployment 标识
     * @param created      本次调用是否真正创建了 Release；false 表示命中幂等重放
     */
    public record Outcome(String releaseId, Long deploymentId, boolean created) { }

    private final AppMapper apps;
    private final PlatformReleaseMapper releases;
    private final PlatformDeploymentMapper deployments;
    private final PlatformTaskLifecycleService lifecycle;
    private final PlatformDeploymentProperties properties;

    public PlatformReleaseService(
        AppMapper apps,
        PlatformReleaseMapper releases,
        PlatformDeploymentMapper deployments,
        PlatformTaskLifecycleService lifecycle,
        PlatformDeploymentProperties properties
    ) {
        this.apps = apps;
        this.releases = releases;
        this.deployments = deployments;
        this.lifecycle = lifecycle;
        this.properties = properties;
    }

    /**
     * 为首次 validated 版本创建固定 Release 并排期部署。
     *
     * @param revision 由本次晋升产生、已写入稳定基线的 SourceRevision
     * @return 空值表示该 Application 已有历史 Release，本次不自动发布（AD-011）
     */
    @Transactional(rollbackFor = Exception.class)
    public Optional<Outcome> releaseFirstVersion(SourceRevision revision) {
        requireRevision(revision);
        // 与晋升共用同一个 Application 行锁：两个写入者必须观察到同一个「是否已有 Release」。
        if (apps.lockApplication(revision.getApplicationId()) == null) {
            throw denied();
        }
        App application = apps.selectOneById(revision.getApplicationId());
        if (application == null || !"ACTIVE".equals(application.getLifecycleStatus())
            || !Objects.equals(application.getIsDelete(), 0)
            || !Objects.equals(application.getStableSourceRevision(), revision.getId())) {
            throw denied();
        }

        String releaseId = releaseId(revision);
        PlatformRelease replay = releases.selectOneByQuery(
            QueryWrapper.create().eq("id", releaseId));
        if (replay != null) {
            if (!sameRevision(replay, revision)) {
                throw denied();
            }
            PlatformDeployment existingDeployment = deployments.selectOneByQuery(
                QueryWrapper.create().eq("releaseId", releaseId));
            if (existingDeployment == null) {
                throw denied();
            }
            return Optional.of(new Outcome(replay.getId(), existingDeployment.getId(), false));
        }

        if (releases.countForOtherTasks(revision.getApplicationId(), revision.getTaskId()) > 0) {
            // AD-011：该 Application 已经发布过，后续版本不自动上线。留痕但不推进任何状态。
            log.info(
                "Platform first release skipped, applicationId: {}, taskId: {}, sourceRevisionId: {}, reasonCode: {}, result: not_first_release",
                revision.getApplicationId(), revision.getTaskId(), revision.getId(), "SUBSEQUENT_VERSION");
            return Optional.empty();
        }

        PlatformRelease release = new PlatformRelease();
        release.setId(releaseId);
        release.setApplicationId(revision.getApplicationId());
        release.setTaskId(revision.getTaskId());
        release.setRunId(revision.getRunId());
        release.setSourceRevisionId(revision.getId());
        release.setProfileVersionId(revision.getProfileVersionId());
        release.setBaselineHash(revision.getBaselineHash());
        release.setCommitHash(revision.getCommitHash());
        release.setTreeHash(revision.getTreeHash());
        release.setValidationAttemptId(revision.getValidationAttemptId());
        release.setRuntimeProfile(requireRuntimeProfile());
        if (releases.insert(release) != 1) {
            throw denied();
        }

        PlatformDeployment deployment = new PlatformDeployment();
        deployment.setApplicationId(revision.getApplicationId());
        deployment.setReleaseId(releaseId);
        deployment.setTaskId(revision.getTaskId());
        deployment.setRequestId(deploymentRequestId(releaseId));
        deployment.setState(PlatformDeploymentState.PENDING.name());
        deployment.setStage(PlatformDeploymentStage.RELEASED.name());
        deployment.setAttemptNumber(1);
        if (deployments.insert(deployment) != 1 || deployment.getId() == null) {
            throw denied();
        }

        lifecycle.markReleased(revision.getTaskId(), "FIRST_RELEASE_CREATED", releaseId, "release:" + releaseId);
        log.info(
            "Platform first release created, applicationId: {}, taskId: {}, sourceRevisionId: {}, releaseId: {}, deploymentId: {}, result: success",
            revision.getApplicationId(), revision.getTaskId(), revision.getId(), releaseId, deployment.getId());
        return Optional.of(new Outcome(releaseId, deployment.getId(), true));
    }

    /**
     * 读取固定 Release。
     *
     * <p>供部署执行器与公开路径解析使用，因此只按 Application 维度返回，避免调用方拼出
     * 不属于该 Application 的 Release。
     */
    @Transactional(readOnly = true)
    public PlatformRelease requireById(Long applicationId, String releaseId) {
        PlatformRelease release = releases.selectOneByQuery(
            QueryWrapper.create().eq("id", releaseId).eq("appId", applicationId));
        if (release == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "固定版本不存在");
        }
        return release;
    }

    /**
     * Release 标识由 Application 与 SourceRevision 派生，不含随机数。
     *
     * <p>这样晋升重放会算出同一个标识，唯一键即可承担幂等职责；用 UUID 的话重放会撞在唯一键上
     * 变成一次无法解释的插入失败。
     */
    static String releaseId(SourceRevision revision) {
        return "rel-" + CandidateGitStore.sha256(revision.getApplicationId()
            + "\n" + revision.getId()).substring(0, 32);
    }

    static String deploymentRequestId(String releaseId) {
        return "deploy-" + releaseId;
    }

    private String requireRuntimeProfile() {
        String profile = properties.getRuntimeProfile();
        if (profile == null || !profile.matches("[A-Z0-9_]{1,32}")) {
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "部署运行时契约名不合法");
        }
        return profile;
    }

    private void requireRevision(SourceRevision revision) {
        if (revision == null || revision.getApplicationId() == null || revision.getId() == null
            || revision.getTaskId() == null || revision.getRunId() == null
            || revision.getProfileVersionId() == null || revision.getBaselineHash() == null
            || revision.getCommitHash() == null || revision.getTreeHash() == null
            || revision.getValidationAttemptId() == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "晋升结果不完整，不能固定 Release");
        }
    }

    private boolean sameRevision(PlatformRelease release, SourceRevision revision) {
        return Objects.equals(release.getApplicationId(), revision.getApplicationId())
            && Objects.equals(release.getTaskId(), revision.getTaskId())
            && Objects.equals(release.getRunId(), revision.getRunId())
            && Objects.equals(release.getSourceRevisionId(), revision.getId())
            && Objects.equals(release.getProfileVersionId(), revision.getProfileVersionId())
            && Objects.equals(release.getBaselineHash(), revision.getBaselineHash())
            && Objects.equals(release.getCommitHash(), revision.getCommitHash())
            && Objects.equals(release.getTreeHash(), revision.getTreeHash())
            && Objects.equals(release.getValidationAttemptId(), revision.getValidationAttemptId());
    }

    private BusinessException denied() {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, "固定 Release 创建条件不满足");
    }
}