package com.zdan.paimengaicodemother.service.impl;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.bean.copier.CopyOptions;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.core.builder.BuilderExecutor;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ConcurrentRunException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.mapper.GenerationRunMapper;
import com.zdan.paimengaicodemother.model.dto.run.AgentCompleteRequest;
import com.zdan.paimengaicodemother.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodemother.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.GenerationRun;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.enums.AgentCompleteStatusEnum;
import com.zdan.paimengaicodemother.model.enums.ChatHistoryMessageTypeEnum;
import com.zdan.paimengaicodemother.model.enums.GenerationRunPhaseEnum;
import com.zdan.paimengaicodemother.model.vo.RunVO;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import com.zdan.paimengaicodemother.service.GenerationRunService;
import lombok.extern.slf4j.Slf4j;
import org.redisson.api.RRateLimiter;
import org.redisson.api.RateType;
import org.redisson.api.RedissonClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Objects;
import java.util.Set;
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

    /**
     * 已完成回调的 runId 集合（完成回调幂等，Issue #6）
     * 单机部署（架构 §1.2）下内存即足够；重复回调直接忽略，不重复写历史/构建
     */
    private final Set<String> completedRunIds = ConcurrentHashMap.newKeySet();

    private final AppService appService;
    private final ChatHistoryService chatHistoryService;
    private final RedissonClient redissonClient;
    private final int wireframeDailyLimit;

    public GenerationRunServiceImpl(AppService appService, ChatHistoryService chatHistoryService,
                                    RedissonClient redissonClient,
                                    @Value("${agent.wireframe-daily-limit:10}") int wireframeDailyLimit) {
        this.appService = appService;
        this.chatHistoryService = chatHistoryService;
        this.redissonClient = redissonClient;
        this.wireframeDailyLimit = wireframeDailyLimit;
    }

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

    @Override
    public void completeRun(String runId, AgentCompleteRequest request) {
        ThrowUtils.throwIf(StrUtil.isBlank(runId), ErrorCode.PARAMS_ERROR, "runId 不能为空");
        // 幂等检查（只读）：回调可能被网络层重试，已处理成功过则直接丢弃，避免重复写历史/构建
        if (completedRunIds.contains(runId)) {
            log.info("run 完成回调已处理过，幂等跳过，runId: {}", runId);
            return;
        }
        validateComplete(request);
        // 归属与构建类型以 Java 侧 app 为准（TS Agent 不传 codeGenType，避免契约冗余）
        App app = appService.getById(request.getAppId());
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR, "应用不存在");
        User user = new User();
        user.setId(request.getUserId());
        if (CollUtil.isNotEmpty(request.getMessages())) {
            // 保持发送顺序逐条落库，避免会话展示错位（user/ai 全文）
            for (AgentCompleteRequest.Message message : request.getMessages()) {
                ThrowUtils.throwIf(ChatHistoryMessageTypeEnum.getEnumByValue(message.getMessageType()) == null,
                        ErrorCode.PARAMS_ERROR, "messageType 仅接受 user/ai");
                chatHistoryService.addChatMessage(request.getAppId(), message.getContent(),
                        message.getMessageType(), user);
            }
        }
        AgentCompleteStatusEnum status = AgentCompleteStatusEnum.getEnumByValue(request.getStatus());
        if (status == AgentCompleteStatusEnum.SUCCESS) {
            // 产物已就绪，构建产出可部署应用（构建管线复用旧链路，失败会抛出由上层映射 500）
            CodeGenTypeEnum codeGenTypeEnum = CodeGenTypeEnum.getEnumByValue(app.getCodeGenType());
            ThrowUtils.throwIf(codeGenTypeEnum == null, ErrorCode.PARAMS_ERROR, "代码生成类型不合法");
            BuilderExecutor.doBuild(codeGenTypeEnum, request.getWorkspacePath());
        } else {
            // 失败无产物可构建，写错误历史让会话有可见反馈
            chatHistoryService.addChatMessage(request.getAppId(),
                    "生成失败：" + StrUtil.blankToDefault(request.getErrorMessage(), "生成失败"),
                    ChatHistoryMessageTypeEnum.AI.getValue(), user);
        }
        // 标记放到校验与副作用全部成功之后：任一步失败时 runId 不落标记，TS Agent 修正后重试可重新处理
        completedRunIds.add(runId);
        log.info("run 完成回调处理成功，runId: {}, status: {}", runId, request.getStatus());
    }

    /**
     * 获取线框生成每日配额（Issue #7）：线框免费 + 每用户每日独立限频，与积分体系无关。
     * 复用 RateLimitAspect 的 Redisson 令牌桶机制（rate_limit: 键前缀 + OVERALL + 滚动窗口）——
     * 内部 Bearer 端点无 servlet session，以请求体 userId 键控（与注解的 session 取用户语义等价）。
     * 键 TTL 设 25 小时：滚动 24h 窗口内不被清理，空闲后自动回收
     *
     * @param userId 用户 id
     * @return 配额获取成功（true）
     */
    @Override
    public boolean acquireWireframeDailyQuota(Long userId) {
        ThrowUtils.throwIf(userId == null || userId <= 0, ErrorCode.PARAMS_ERROR, "userId 不能为空");
        String key = "rate_limit:user:" + userId + ":wireframe_daily";
        RRateLimiter rateLimiter = redissonClient.getRateLimiter(key);
        rateLimiter.expire(Duration.ofHours(25));
        // rate = 每 86400s 允许的令牌数（滚动 24h 窗口），等价「每用户每日 N 次」
        rateLimiter.trySetRate(RateType.OVERALL, wireframeDailyLimit, Duration.ofSeconds(86400));
        if (!rateLimiter.tryAcquire(1)) {
            throw new BusinessException(ErrorCode.TOO_MANY_REQUEST, "今日线框生成次数已用完，请明天再试");
        }
        return true;
    }

    /**
     * 校验完成回调请求（appId/userId/status/workspacePath）
     *
     * @param request 完成回调请求
     */
    private void validateComplete(AgentCompleteRequest request) {
        ThrowUtils.throwIf(request == null, ErrorCode.PARAMS_ERROR, "请求不能为空");
        ThrowUtils.throwIf(request.getAppId() == null || request.getAppId() <= 0,
                ErrorCode.PARAMS_ERROR, "appId 不能为空");
        ThrowUtils.throwIf(request.getUserId() == null || request.getUserId() <= 0,
                ErrorCode.PARAMS_ERROR, "userId 不能为空");
        AgentCompleteStatusEnum status = AgentCompleteStatusEnum.getEnumByValue(request.getStatus());
        ThrowUtils.throwIf(status == null, ErrorCode.PARAMS_ERROR, "status 仅接受 success/failed");
        // success 时需要工作区路径触发构建（failed 无产物可构建，允许为空）
        ThrowUtils.throwIf(status == AgentCompleteStatusEnum.SUCCESS && StrUtil.isBlank(request.getWorkspacePath()),
                ErrorCode.PARAMS_ERROR, "workspacePath 不能为空");
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
