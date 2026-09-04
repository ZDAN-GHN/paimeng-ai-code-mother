package com.zdan.paimengaicodemother.service.impl;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.bean.copier.CopyOptions;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ConcurrentRunException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.mapper.GenerationRunMapper;
import com.zdan.paimengaicodemother.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodemother.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodemother.model.entity.GenerationRun;
import com.zdan.paimengaicodemother.model.enums.GenerationRunPhaseEnum;
import com.zdan.paimengaicodemother.model.vo.RunVO;
import com.zdan.paimengaicodemother.service.GenerationRunService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 生成运行（generation_run）服务层实现。
 *
 * @author LXH
 */
@Slf4j
@Service
public class GenerationRunServiceImpl extends ServiceImpl<GenerationRunMapper, GenerationRun>
        implements GenerationRunService {

    /**
     * 并发拒绝文案（验收口径：「当前有进行中的任务」）
     */
    public static final String CONCURRENT_MESSAGE = "当前有进行中的任务";

    /**
     * 终态 phase 列表（非终态 run 用于断点续传与并发拒绝判定）
     */
    private static final List<String> TERMINAL_PHASES = List.of(
            GenerationRunPhaseEnum.DONE.getValue(),
            GenerationRunPhaseEnum.FAILED.getValue(),
            GenerationRunPhaseEnum.ABORTED.getValue());

    /**
     * 每 app 一把锁：串行化「同 app 幂等检查 + 并发检查 + 落库」，杜绝并发下双双通过检查
     * （单实例部署下成立；多实例时需依赖 DB 层约束，见 docs/ts_agent/architecture.md 单机部署前提）
     */
    private final ConcurrentHashMap<Long, Object> appLocks = new ConcurrentHashMap<>();

    @Override
    public RunVO createRun(RunCreateRequest request) {
        validateCreate(request);
        synchronized (lockFor(request.getAppId())) {
            // 幂等：同 runId 已存在（断点续传重放）→ 直接返回既有 run，不产生重复行
            GenerationRun existing = this.getById(request.getRunId());
            if (existing != null) {
                log.info("run 已存在，幂等返回，runId: {}", request.getRunId());
                return toVO(existing);
            }
            // 并发：同 app 已有非终态 run → 409「当前有进行中的任务」
            GenerationRun active = getLatestNonTerminalRunEntity(request.getAppId(), null);
            if (active != null) {
                log.warn("同 app 存在进行中的 run，拒绝新建，appId: {}, activeRunId: {}, newRunId: {}",
                        request.getAppId(), active.getRunId(), request.getRunId());
                throw new ConcurrentRunException(CONCURRENT_MESSAGE);
            }
            GenerationRun entity = new GenerationRun();
            BeanUtil.copyProperties(request, entity);
            if (entity.getStartedTime() == null) {
                entity.setStartedTime(LocalDateTime.now());
            }
            boolean saved = this.save(entity);
            ThrowUtils.throwIf(!saved, ErrorCode.OPERATION_ERROR, "创建运行失败");
            log.info("run 创建成功，runId: {}, appId: {}, phase: {}", entity.getRunId(), entity.getAppId(), entity.getPhase());
            return toVO(entity);
        }
    }

    @Override
    public RunVO updateRun(String runId, RunUpdateRequest request) {
        ThrowUtils.throwIf(StrUtil.isBlank(runId), ErrorCode.PARAMS_ERROR, "runId 不能为空");
        ThrowUtils.throwIf(request == null, ErrorCode.PARAMS_ERROR, "请求不能为空");
        String phase = request.getPhase();
        if (StrUtil.isNotBlank(phase)) {
            ThrowUtils.throwIf(GenerationRunPhaseEnum.getEnumByValue(phase) == null,
                    ErrorCode.PARAMS_ERROR, "phase 非法");
        }
        validateJsonField("context", request.getContext());
        validateJsonField("milestones", request.getMilestones());
        validateJsonField("tokenUsage", request.getTokenUsage());

        GenerationRun existing = this.getById(runId);
        ThrowUtils.throwIf(existing == null, ErrorCode.NOT_FOUND_ERROR, "运行不存在");

        GenerationRun update = new GenerationRun();
        update.setRunId(runId);
        // 只复制非空字段（整体覆盖语义由调用方控制：传全量 JSON 即覆盖）
        BeanUtil.copyProperties(request, update, CopyOptions.create().setIgnoreNullValue(true));
        // 进入终态且未显式给结束时间 → 服务端补 finished_time
        if (StrUtil.isNotBlank(update.getPhase())
                && GenerationRunPhaseEnum.isTerminal(GenerationRunPhaseEnum.getEnumByValue(update.getPhase()))
                && update.getFinishedTime() == null) {
            update.setFinishedTime(LocalDateTime.now());
        }

        // 幂等：与既有值完全一致则不落库（不刷新 updateTime、不触发下游副作用）
        if (hasChanges(existing, update)) {
            boolean updated = this.updateById(update);
            ThrowUtils.throwIf(!updated, ErrorCode.OPERATION_ERROR, "更新运行失败");
            // 重新读取以拿到最新 updateTime 返回
            GenerationRun refreshed = this.getById(runId);
            log.info("run 更新成功，runId: {}, phase: {}", runId, refreshed.getPhase());
            return toVO(refreshed);
        }
        log.info("run 更新无变化，幂等跳过，runId: {}", runId);
        return toVO(existing);
    }

    @Override
    public RunVO getByRunId(String runId) {
        if (StrUtil.isBlank(runId)) {
            return null;
        }
        return toVO(this.getById(runId));
    }

    @Override
    public RunVO getLatestNonTerminalRun(Long appId, Long userId) {
        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "appId 不能为空");
        return toVO(getLatestNonTerminalRunEntity(appId, userId));
    }

    /**
     * 查询同 app 最新非终态 run 实体（终态过滤 + 按创建时间倒序取最新一条）
     *
     * @param appId  应用 id
     * @param userId 用户 id（可空，为空不过滤）
     * @return 最新非终态 run，无则返回 null
     */
    private GenerationRun getLatestNonTerminalRunEntity(Long appId, Long userId) {
        QueryWrapper queryWrapper = QueryWrapper.create()
                .eq(GenerationRun::getAppId, appId)
                .notIn(GenerationRun::getPhase, TERMINAL_PHASES)
                .orderBy(GenerationRun::getCreateTime, false)
                .limit(1);
        if (userId != null && userId > 0) {
            queryWrapper.eq(GenerationRun::getUserId, userId);
        }
        List<GenerationRun> list = this.list(queryWrapper);
        return list.isEmpty() ? null : list.get(0);
    }

    /**
     * 获取 app 级锁对象（无则创建）
     *
     * @param appId 应用 id
     * @return 锁对象
     */
    private Object lockFor(Long appId) {
        return appLocks.computeIfAbsent(appId, key -> new Object());
    }

    /**
     * 校验创建请求（runId/appId/userId/phase/JSON 字段）
     *
     * @param request 创建请求
     */
    private void validateCreate(RunCreateRequest request) {
        ThrowUtils.throwIf(request == null, ErrorCode.PARAMS_ERROR, "请求不能为空");
        ThrowUtils.throwIf(StrUtil.isBlank(request.getRunId()), ErrorCode.PARAMS_ERROR, "runId 不能为空");
        ThrowUtils.throwIf(request.getAppId() == null || request.getAppId() <= 0,
                ErrorCode.PARAMS_ERROR, "appId 不能为空");
        ThrowUtils.throwIf(request.getUserId() == null || request.getUserId() <= 0,
                ErrorCode.PARAMS_ERROR, "userId 不能为空");
        ThrowUtils.throwIf(GenerationRunPhaseEnum.getEnumByValue(request.getPhase()) == null,
                ErrorCode.PARAMS_ERROR, "phase 非法");
        validateJsonField("context", request.getContext());
        validateJsonField("milestones", request.getMilestones());
        validateJsonField("tokenUsage", request.getTokenUsage());
    }

    /**
     * 校验 JSON 字段（context/milestones/token_usage 必须为合法 JSON，为空跳过）
     *
     * @param fieldName 字段名（用于报错文案）
     * @param json      JSON 文本
     */
    private void validateJsonField(String fieldName, String json) {
        if (StrUtil.isBlank(json)) {
            return;
        }
        try {
            JSONUtil.parse(json);
        } catch (Exception e) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, fieldName + " 必须是合法 JSON");
        }
    }

    /**
     * 判断更新是否产生实际变化（任一非空字段与既有值不同即视为变化）
     *
     * @param existing 既有 run
     * @param update   待更新 run（非空字段即待写入值）
     * @return true 表示存在变化需要落库
     */
    private boolean hasChanges(GenerationRun existing, GenerationRun update) {
        return !Objects.equals(existing.getPhase(), update.getPhase())
                || !Objects.equals(existing.getContext(), update.getContext())
                || !Objects.equals(existing.getMilestones(), update.getMilestones())
                || !Objects.equals(existing.getTokenUsage(), update.getTokenUsage())
                || !Objects.equals(existing.getCreditLedgerRef(), update.getCreditLedgerRef())
                || !Objects.equals(existing.getFinishedTime(), update.getFinishedTime());
    }

    /**
     * 实体转视图对象
     *
     * @param entity 实体
     * @return 视图对象，实体为 null 时返回 null
     */
    private RunVO toVO(GenerationRun entity) {
        if (entity == null) {
            return null;
        }
        RunVO vo = new RunVO();
        BeanUtil.copyProperties(entity, vo);
        return vo;
    }
}
