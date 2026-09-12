package com.zdan.paimengaicodemother.service.impl;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.bean.copier.CopyOptions;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodemother.ai.agent.AgentProperties;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.core.builder.BuilderExecutor;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ConcurrentRunException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.mapper.GenerationRunMapper;
import com.zdan.paimengaicodemother.model.dto.run.AgentCompleteRequest;
import com.zdan.paimengaicodemother.model.dto.run.CreditFreezeRequest;
import com.zdan.paimengaicodemother.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodemother.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.CreditLedger;
import com.zdan.paimengaicodemother.model.entity.GenerationRun;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.enums.AgentCompleteStatusEnum;
import com.zdan.paimengaicodemother.model.enums.ChatHistoryMessageTypeEnum;
import com.zdan.paimengaicodemother.model.enums.CreditLedgerStatusEnum;
import com.zdan.paimengaicodemother.model.enums.GenerationRunPhaseEnum;
import com.zdan.paimengaicodemother.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodemother.model.vo.RunVO;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import com.zdan.paimengaicodemother.service.CreditService;
import com.zdan.paimengaicodemother.service.GenerationRunService;
import lombok.extern.slf4j.Slf4j;
import org.redisson.api.RRateLimiter;
import org.redisson.api.RateType;
import org.redisson.api.RedissonClient;
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
     * 用户中断历史标记（Issue #10 验收：中断后历史带 [用户中断] 标记）
     */
    public static final String INTERRUPT_MARK = "[用户中断] ";

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
    private final CreditService creditService;
    private final RedissonClient redissonClient;
    private final AgentProperties agentProperties;

    public GenerationRunServiceImpl(AppService appService, ChatHistoryService chatHistoryService,
                                    RedissonClient redissonClient,
                                    AgentProperties agentProperties,
                                    CreditService creditService) {
        this.appService = appService;
        this.chatHistoryService = chatHistoryService;
        this.redissonClient = redissonClient;
        this.creditService = creditService;
        this.agentProperties = agentProperties;
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

    private static final Set<String> FAILURE_CODES = Set.of(
            "guardrail-rejected", "quality-gate-exhausted", "limit-reached", "model-error", "unknown");

    private static String normalizeFailureCode(String errorCode) {
        return FAILURE_CODES.contains(errorCode) ? errorCode : "unknown";
    }

    @Override
    public void completeRun(String runId, AgentCompleteRequest request) {
        ThrowUtils.throwIf(StrUtil.isBlank(runId), ErrorCode.PARAMS_ERROR, "runId 不能为空");
        // 幂等检查（只读）：回调可能被网络层重试，已处理成功过则直接丢弃，避免重复写历史/构建/记账
        if (completedRunIds.contains(runId)) {
            log.info("run 完成回调已处理过，幂等跳过，runId: {}", runId);
            return;
        }
        // 记账幂等（AC4 并发 / AC5 迟到回调）：台账已非冻结态（已结算/退款）→ 本 run 已记账，直接丢弃，
        // 不再执行任何分支副作用（不重复写历史/构建/记账）——不依赖内存集合，进程重启丢集也成立
        CreditLedger ledger = creditService.getByRunId(runId);
        if (ledger != null && !CreditLedgerStatusEnum.FROZEN.getValue().equals(ledger.getStatus())) {
            log.info("台账已终态（{}），迟到/重复回调幂等跳过，runId: {}", ledger.getStatus(), runId);
            return;
        }
        validateComplete(request);
        // 归属与构建类型以 Java 侧 app 为准（TS Agent 不传 codeGenType，避免契约冗余）
        App app = appService.getById(request.getAppId());
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR, "应用不存在");
        User user = new User();
        user.setId(request.getUserId());
        AgentCompleteStatusEnum status = AgentCompleteStatusEnum.getEnumByValue(request.getStatus());
        // AC5 run 终态与台账一致：run 已终态但本次回调终态与之不符 → 拒绝（迟到错序回调不得改写 run 状态）；
        // 终态与 status 一致（TS 先置 run 终态再回调的 aborted/failed 正常路径）放行，由台账条件更新兜底幂等
        GenerationRun run = this.getById(runId);
        if (run != null) {
            GenerationRunPhaseEnum currentPhase = GenerationRunPhaseEnum.getEnumByValue(run.getPhase());
            if (GenerationRunPhaseEnum.isTerminal(currentPhase)
                    && terminalPhaseOf(status) != currentPhase) {
                log.warn("run 已终态（{}）与回调 status（{}）不一致，拒绝处理，runId: {}",
                        currentPhase.getValue(), request.getStatus(), runId);
                return;
            }
        }
        // 中断折算用的里程碑数（退款粒度的锚，架构 §3.2）：从 run.milestones JSON 解析
        Integer milestoneCount = resolveMilestoneCount(runId);
        if (CollUtil.isNotEmpty(request.getMessages())) {
            // 保持发送顺序逐条落库，避免会话展示错位（user/ai 全文）
            for (AgentCompleteRequest.Message message : request.getMessages()) {
                ThrowUtils.throwIf(ChatHistoryMessageTypeEnum.getEnumByValue(message.getMessageType()) == null,
                        ErrorCode.PARAMS_ERROR, "messageType 仅接受 user/ai");
                String content = message.getContent();
                // 空内容跳过：failed 回调的 ai 可能为空（无产物内容，Java failed 分支另写错误历史），
                // 空消息落库会抛「消息不能为空」，导致整个回调失败、记账/退款不执行（e2e 实测）
                if (StrUtil.isBlank(content)) {
                    log.info("跳过空消息（{}），runId: {}", message.getMessageType(), runId);
                    continue;
                }
                // 用户中断：历史带 [用户中断] 标记（Issue #10 验收）
                if (status == AgentCompleteStatusEnum.ABORTED
                        && ChatHistoryMessageTypeEnum.AI.getValue().equals(message.getMessageType())
                        && !content.startsWith(INTERRUPT_MARK)) {
                    content = INTERRUPT_MARK + content;
                }
                chatHistoryService.addChatMessage(request.getAppId(), content, message.getMessageType(), user);
            }
        }
        // 记账（台账与用户余额同库同事务，CreditService 内部 @Transactional；runId 幂等防重复记账）
        if (status == AgentCompleteStatusEnum.SUCCESS) {
            creditService.settleRun(runId);
            // 产物已就绪，构建产出可部署应用（构建管线复用旧链路，失败会抛出由上层映射 500）
            CodeGenTypeEnum codeGenTypeEnum = CodeGenTypeEnum.getEnumByValue(app.getCodeGenType());
            ThrowUtils.throwIf(codeGenTypeEnum == null, ErrorCode.PARAMS_ERROR, "代码生成类型不合法");
            BuilderExecutor.doBuild(codeGenTypeEnum, request.getWorkspacePath());
            markRunTerminal(runId, GenerationRunPhaseEnum.DONE);
        } else if (status == AgentCompleteStatusEnum.FAILED) {
            creditService.refundRun(runId, status, null, milestoneCount);
            // 失败无产物可构建，写错误历史让会话有可见反馈
            String errorCode = normalizeFailureCode(StrUtil.blankToDefault(request.getErrorCode(), "unknown"));
            String errorMessage = StrUtil.blankToDefault(request.getErrorMessage(), "生成失败");
            log.warn("Agent 生成失败，runId: {}，errorCode: {}，message: {}", runId, errorCode, errorMessage);
            // 稳定代码供服务端检索，人话文案保持在后缀，避免调用方只能解析自由文本。
            chatHistoryService.addChatMessage(request.getAppId(),
                    "生成失败[" + errorCode + "]:" + errorMessage,
                    ChatHistoryMessageTypeEnum.AI.getValue(), user);
            markRunTerminal(runId, GenerationRunPhaseEnum.FAILED);
        } else if (status == AgentCompleteStatusEnum.ABORTED) {
            // aborted：保留已写文件（Agent 侧不删），按里程碑折算退款（首文件落盘前全额退）
            creditService.refundRun(runId, status, request.getFilesWritten(), milestoneCount);
            markRunTerminal(runId, GenerationRunPhaseEnum.ABORTED);
        } else {
            // 理论不可达：validateComplete 已校验 status 仅 success/failed/aborted
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "status 非法");
        }
        // 标记放到校验与副作用全部成功之后：任一步失败时 runId 不落标记，TS Agent 修正后重试可重新处理
        completedRunIds.add(runId);
        log.info("run 完成回调处理成功，runId: {}, status: {}", runId, request.getStatus());
    }

    @Override
    public CreditFreezeVO freezeCredit(String runId, CreditFreezeRequest request) {
        ThrowUtils.throwIf(StrUtil.isBlank(runId), ErrorCode.PARAMS_ERROR, "runId 不能为空");
        GenerationRun run = this.getById(runId);
        ThrowUtils.throwIf(run == null, ErrorCode.NOT_FOUND_ERROR, "运行不存在");
        // 幂等：creditLedgerRef 已关联（同 run 已冻结过）→ 直接返回既有台账，不重复扣款
        if (StrUtil.isNotBlank(run.getCreditLedgerRef())) {
            CreditLedger ledger = creditService.getByRunId(runId);
            if (ledger != null) {
                log.info("run 已冻结，幂等返回既有台账，runId: {}, ledgerId: {}", runId, ledger.getId());
                return creditService.buildFreezeVO(ledger);
            }
        }
        // 冻结前置：只有已确认线框（进入 codegen）才冻结（架构 §4 闸门经济学，线框阶段免费）
        ThrowUtils.throwIf(!GenerationRunPhaseEnum.WIREFRAME_CONFIRMED.getValue().equals(run.getPhase()),
                ErrorCode.FORBIDDEN_ERROR,
                "当前阶段（" + run.getPhase() + "）不能冻结积分，请先确认线框");
        CreditFreezeVO vo = creditService.freeze(runId, run.getAppId(), run.getUserId(),
                request == null ? null : request.getIntensity());
        // 台账关联写回 run（同库；供对账与幂等复用 creditLedgerRef 预留字段）
        GenerationRun update = new GenerationRun();
        update.setRunId(runId);
        update.setCreditLedgerRef(String.valueOf(vo.getLedgerId()));
        this.updateById(update);
        return vo;
    }

    @Override
    public boolean acquireWireframeDailyQuota(Long userId) {
        ThrowUtils.throwIf(userId == null || userId <= 0, ErrorCode.PARAMS_ERROR, "userId 不能为空");
        // 复用 RateLimitAspect 的 Redisson 令牌桶机制：内部 Bearer 端点无 servlet session，无法走注解
        // USER 型取登录用户，改以请求体 userId 键控（机制同源：rate_limit: 前缀 + OVERALL + tryAcquire）
        String key = "rate_limit:user:" + userId + ":wireframe_daily";
        RRateLimiter rateLimiter = redissonClient.getRateLimiter(key);
        // 键 TTL 25 小时：滚动 24h 窗口内不被清理，空闲后自动回收
        rateLimiter.expire(Duration.ofHours(25));
        // rate = 每 86400s 允许的令牌数（滚动 24h 窗口），等价「每用户每日 N 次」
        rateLimiter.trySetRate(RateType.OVERALL, agentProperties.getWireframeDailyLimit(), Duration.ofSeconds(86400));
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
        ThrowUtils.throwIf(status == null, ErrorCode.PARAMS_ERROR, "status 仅接受 success/failed/aborted");
        // success 时需要工作区路径触发构建（failed/aborted 无产物可构建，允许为空）
        ThrowUtils.throwIf(status == AgentCompleteStatusEnum.SUCCESS && StrUtil.isBlank(request.getWorkspacePath()),
                ErrorCode.PARAMS_ERROR, "workspacePath 不能为空");
    }

    /**
     * 把 run 推进到终态 phase（已终态幂等跳过；供「run 终态与台账状态一致」验收兜底）
     *
     * @param runId 运行 id
     * @param phase 终态阶段（done/failed/aborted）
     */
    private void markRunTerminal(String runId, GenerationRunPhaseEnum phase) {
        GenerationRun existing = this.getById(runId);
        if (existing == null) {
            return;
        }
        if (GenerationRunPhaseEnum.isTerminal(GenerationRunPhaseEnum.getEnumByValue(existing.getPhase()))) {
            return;
        }
        GenerationRun update = new GenerationRun();
        update.setRunId(runId);
        update.setPhase(phase.getValue());
        update.setFinishedTime(LocalDateTime.now());
        this.updateById(update);
    }

    /**
     * 从 run.milestones JSON 解析已过里程碑数（退款折算锚，架构 §3.2；解析失败返回 null）
     *
     * @param runId 运行 id
     * @return 里程碑数，无/解析失败返回 null
     */
    private Integer resolveMilestoneCount(String runId) {
        GenerationRun run = this.getById(runId);
        if (run == null || StrUtil.isBlank(run.getMilestones())) {
            return null;
        }
        try {
            return JSONUtil.parseArray(run.getMilestones()).size();
        } catch (Exception e) {
            log.warn("run.milestones 解析失败，runId: {}", runId);
            return null;
        }
    }

    /**
     * 完成回调终态 → run 终态 phase 映射（AC5「run 终态与台账一致」的一致性判断锚）
     *
     * @param status 完成回调终态
     * @return 对应 run 终态 phase
     */
    private GenerationRunPhaseEnum terminalPhaseOf(AgentCompleteStatusEnum status) {
        return switch (status) {
            case SUCCESS -> GenerationRunPhaseEnum.DONE;
            case FAILED -> GenerationRunPhaseEnum.FAILED;
            case ABORTED -> GenerationRunPhaseEnum.ABORTED;
        };
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
