package com.zdan.paimengaicodebackend.platform.domain;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunProgressEventMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunProgressEvent;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Owner 安全进度的唯一写入口（Issue #80 / T-08）
 * <p>
 * Runtime 上报的是粗粒度阶段，不是 Agent 的原始事件流：工具名、参数、命令输出、
 * Pi Session 与 Sandbox 标识都不允许进入这张表，否则状态 API 就会把内部执行细节
 * 透给 Owner，违反 D-06 对 Product Layer 边界的要求。
 */
@Service
public class PlatformRunProgressService {

    private static final int MAX_NOTE_LENGTH = 120;

    private final PlatformRunProgressEventMapper progressMapper;
    private final PlatformStatusChangeNotifier notifier;

    public PlatformRunProgressService(
        PlatformRunProgressEventMapper progressMapper,
        PlatformStatusChangeNotifier notifier
    ) {
        this.progressMapper = progressMapper;
        this.notifier = notifier;
    }

    @Transactional(rollbackFor = Exception.class)
    public void record(
        long applicationId,
        long taskId,
        String runId,
        PlatformProgressStage stage,
        String note
    ) {
        if (applicationId <= 0 || taskId <= 0 || stage == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "进度事件参数不完整");
        }
        PlatformRunProgressEvent event = new PlatformRunProgressEvent();
        event.setAppId(applicationId);
        event.setTaskId(taskId);
        event.setRunId(runId);
        event.setStage(stage.name());
        event.setNote(sanitizeNote(stage, note));
        if (progressMapper.insertSelective(event) != 1) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "进度事件写入失败");
        }
        notifier.notifyAfterCommit(applicationId);
    }

    public PlatformRunProgressEvent latest(long applicationId, long taskId) {
        return progressMapper.selectLatest(applicationId, taskId);
    }

    /**
     * Owner 说明只保留单行、限长并去掉控制字符。
     *
     * <p>不做更聪明的清洗：阶段已经由枚举收敛，说明文本只是给人看的提示，
     * 真正的事实以 Task/Run 状态为准。
     *
     * <p>因此 {@code note} 是审计文本而非展示数据：状态投影刻意不读它，Owner 看到的状态由
     * Task 状态与阶段枚举决定。一旦有人要把 note 接进投影，必须先确认 Runtime 上报的这段
     * 自由文本对 Owner 可见是否安全，以及它的长度与控制字符边界是否仍然成立。
     */
    private String sanitizeNote(PlatformProgressStage stage, String note) {
        if (note == null || note.isBlank()) {
            return stage.note();
        }
        String flattened = note.replaceAll("\\s+", " ").trim();
        if (flattened.length() > MAX_NOTE_LENGTH) {
            flattened = flattened.substring(0, MAX_NOTE_LENGTH);
        }
        return flattened;
    }
}
