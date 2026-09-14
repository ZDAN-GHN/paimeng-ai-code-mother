package com.zdan.paimengaicodebackend.service.impl;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.bean.copier.CopyOptions;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodebackend.ai.agent.AgentProperties;
import com.zdan.paimengaicodebackend.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodebackend.core.builder.BuilderExecutor;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ConcurrentRunException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.exception.ThrowUtils;
import com.zdan.paimengaicodebackend.mapper.GenerationRunMapper;
import com.zdan.paimengaicodebackend.model.dto.run.AgentCompleteRequest;
import com.zdan.paimengaicodebackend.model.dto.run.CreditFreezeRequest;
import com.zdan.paimengaicodebackend.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodebackend.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.CreditLedger;
import com.zdan.paimengaicodebackend.model.entity.GenerationRun;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.model.enums.AgentCompleteStatusEnum;
import com.zdan.paimengaicodebackend.model.enums.ChatHistoryMessageTypeEnum;
import com.zdan.paimengaicodebackend.model.enums.CreditLedgerStatusEnum;
import com.zdan.paimengaicodebackend.model.enums.GenerationRunPhaseEnum;
import com.zdan.paimengaicodebackend.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodebackend.model.vo.RunVO;
import com.zdan.paimengaicodebackend.service.AppService;
import com.zdan.paimengaicodebackend.service.ChatHistoryService;
import com.zdan.paimengaicodebackend.service.CreditService;
import com.zdan.paimengaicodebackend.service.GenerationRunService;
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


@Slf4j
@Service
public class GenerationRunServiceImpl extends ServiceImpl<GenerationRunMapper, GenerationRun>
        implements GenerationRunService {


    public static final String CONCURRENT_MESSAGE = "当前有进行中的任务";


    public static final String INTERRUPT_MARK = "[用户中断] ";


    private static final List<String> TERMINAL_PHASES = List.of(
            GenerationRunPhaseEnum.DONE.getValue(),
            GenerationRunPhaseEnum.FAILED.getValue(),
            GenerationRunPhaseEnum.ABORTED.getValue());


    private final ConcurrentHashMap<Long, Object> appLocks = new ConcurrentHashMap<>();


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

            GenerationRun existing = this.getById(request.getRunId());
            if (existing != null) {
                log.info("run 已存在，幂等返回，runId: {}", request.getRunId());
                return toVO(existing);
            }

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

        BeanUtil.copyProperties(request, update, CopyOptions.create().setIgnoreNullValue(true));

        if (StrUtil.isNotBlank(update.getPhase())
                && GenerationRunPhaseEnum.isTerminal(GenerationRunPhaseEnum.getEnumByValue(update.getPhase()))
                && update.getFinishedTime() == null) {
            update.setFinishedTime(LocalDateTime.now());
        }


        if (hasChanges(existing, update)) {
            boolean updated = this.updateById(update);
            ThrowUtils.throwIf(!updated, ErrorCode.OPERATION_ERROR, "更新运行失败");

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

        if (completedRunIds.contains(runId)) {
            log.info("run 完成回调已处理过，幂等跳过，runId: {}", runId);
            return;
        }


        CreditLedger ledger = creditService.getByRunId(runId);
        if (ledger != null && !CreditLedgerStatusEnum.FROZEN.getValue().equals(ledger.getStatus())) {
            log.info("台账已终态（{}），迟到/重复回调幂等跳过，runId: {}", ledger.getStatus(), runId);
            return;
        }
        validateComplete(request);

        App app = appService.getById(request.getAppId());
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR, "应用不存在");
        User user = new User();
        user.setId(request.getUserId());
        AgentCompleteStatusEnum status = AgentCompleteStatusEnum.getEnumByValue(request.getStatus());


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

        Integer milestoneCount = resolveMilestoneCount(runId);
        if (CollUtil.isNotEmpty(request.getMessages())) {

            for (AgentCompleteRequest.Message message : request.getMessages()) {
                ThrowUtils.throwIf(ChatHistoryMessageTypeEnum.getEnumByValue(message.getMessageType()) == null,
                        ErrorCode.PARAMS_ERROR, "messageType 仅接受 user/ai");
                String content = message.getContent();


                if (StrUtil.isBlank(content)) {
                    log.info("跳过空消息（{}），runId: {}", message.getMessageType(), runId);
                    continue;
                }

                if (status == AgentCompleteStatusEnum.ABORTED
                        && ChatHistoryMessageTypeEnum.AI.getValue().equals(message.getMessageType())
                        && !content.startsWith(INTERRUPT_MARK)) {
                    content = INTERRUPT_MARK + content;
                }
                chatHistoryService.addChatMessage(request.getAppId(), content, message.getMessageType(), user);
            }
        }

        if (status == AgentCompleteStatusEnum.SUCCESS) {
            creditService.settleRun(runId);

            CodeGenTypeEnum codeGenTypeEnum = CodeGenTypeEnum.getEnumByValue(app.getCodeGenType());
            ThrowUtils.throwIf(codeGenTypeEnum == null, ErrorCode.PARAMS_ERROR, "代码生成类型不合法");
            BuilderExecutor.doBuild(codeGenTypeEnum, request.getWorkspacePath());
            markRunTerminal(runId, GenerationRunPhaseEnum.DONE);
        } else if (status == AgentCompleteStatusEnum.FAILED) {
            creditService.refundRun(runId, status, null, milestoneCount);

            String errorCode = normalizeFailureCode(StrUtil.blankToDefault(request.getErrorCode(), "unknown"));
            String errorMessage = StrUtil.blankToDefault(request.getErrorMessage(), "生成失败");
            log.warn("Agent 生成失败，runId: {}，errorCode: {}，message: {}", runId, errorCode, errorMessage);

            chatHistoryService.addChatMessage(request.getAppId(),
                    "生成失败[" + errorCode + "]:" + errorMessage,
                    ChatHistoryMessageTypeEnum.AI.getValue(), user);
            markRunTerminal(runId, GenerationRunPhaseEnum.FAILED);
        } else if (status == AgentCompleteStatusEnum.ABORTED) {

            creditService.refundRun(runId, status, request.getFilesWritten(), milestoneCount);
            markRunTerminal(runId, GenerationRunPhaseEnum.ABORTED);
        } else {

            throw new BusinessException(ErrorCode.PARAMS_ERROR, "status 非法");
        }

        completedRunIds.add(runId);
        log.info("run 完成回调处理成功，runId: {}, status: {}", runId, request.getStatus());
    }

    @Override
    public CreditFreezeVO freezeCredit(String runId, CreditFreezeRequest request) {
        ThrowUtils.throwIf(StrUtil.isBlank(runId), ErrorCode.PARAMS_ERROR, "runId 不能为空");
        GenerationRun run = this.getById(runId);
        ThrowUtils.throwIf(run == null, ErrorCode.NOT_FOUND_ERROR, "运行不存在");

        if (StrUtil.isNotBlank(run.getCreditLedgerRef())) {
            CreditLedger ledger = creditService.getByRunId(runId);
            if (ledger != null) {
                log.info("run 已冻结，幂等返回既有台账，runId: {}, ledgerId: {}", runId, ledger.getId());
                return creditService.buildFreezeVO(ledger);
            }
        }

        ThrowUtils.throwIf(!GenerationRunPhaseEnum.WIREFRAME_CONFIRMED.getValue().equals(run.getPhase()),
                ErrorCode.FORBIDDEN_ERROR,
                "当前阶段（" + run.getPhase() + "）不能冻结积分，请先确认线框");
        CreditFreezeVO vo = creditService.freeze(runId, run.getAppId(), run.getUserId(),
                request == null ? null : request.getIntensity());

        GenerationRun update = new GenerationRun();
        update.setRunId(runId);
        update.setCreditLedgerRef(String.valueOf(vo.getLedgerId()));
        this.updateById(update);
        return vo;
    }

    @Override
    public boolean acquireWireframeDailyQuota(Long userId) {
        ThrowUtils.throwIf(userId == null || userId <= 0, ErrorCode.PARAMS_ERROR, "userId 不能为空");


        String key = "rate_limit:user:" + userId + ":wireframe_daily";
        RRateLimiter rateLimiter = redissonClient.getRateLimiter(key);

        rateLimiter.expire(Duration.ofHours(25));

        rateLimiter.trySetRate(RateType.OVERALL, agentProperties.getWireframeDailyLimit(), Duration.ofSeconds(86400));
        if (!rateLimiter.tryAcquire(1)) {
            throw new BusinessException(ErrorCode.TOO_MANY_REQUEST, "今日线框生成次数已用完，请明天再试");
        }
        return true;
    }


    private void validateComplete(AgentCompleteRequest request) {
        ThrowUtils.throwIf(request == null, ErrorCode.PARAMS_ERROR, "请求不能为空");
        ThrowUtils.throwIf(request.getAppId() == null || request.getAppId() <= 0,
                ErrorCode.PARAMS_ERROR, "appId 不能为空");
        ThrowUtils.throwIf(request.getUserId() == null || request.getUserId() <= 0,
                ErrorCode.PARAMS_ERROR, "userId 不能为空");
        AgentCompleteStatusEnum status = AgentCompleteStatusEnum.getEnumByValue(request.getStatus());
        ThrowUtils.throwIf(status == null, ErrorCode.PARAMS_ERROR, "status 仅接受 success/failed/aborted");

        ThrowUtils.throwIf(status == AgentCompleteStatusEnum.SUCCESS && StrUtil.isBlank(request.getWorkspacePath()),
                ErrorCode.PARAMS_ERROR, "workspacePath 不能为空");
    }


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


    private GenerationRunPhaseEnum terminalPhaseOf(AgentCompleteStatusEnum status) {
        return switch (status) {
            case SUCCESS -> GenerationRunPhaseEnum.DONE;
            case FAILED -> GenerationRunPhaseEnum.FAILED;
            case ABORTED -> GenerationRunPhaseEnum.ABORTED;
        };
    }


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


    private Object lockFor(Long appId) {
        return appLocks.computeIfAbsent(appId, key -> new Object());
    }


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


    private boolean hasChanges(GenerationRun existing, GenerationRun update) {
        return !Objects.equals(existing.getPhase(), update.getPhase())
                || !Objects.equals(existing.getContext(), update.getContext())
                || !Objects.equals(existing.getMilestones(), update.getMilestones())
                || !Objects.equals(existing.getTokenUsage(), update.getTokenUsage())
                || !Objects.equals(existing.getCreditLedgerRef(), update.getCreditLedgerRef())
                || !Objects.equals(existing.getFinishedTime(), update.getFinishedTime());
    }


    private RunVO toVO(GenerationRun entity) {
        if (entity == null) {
            return null;
        }
        RunVO vo = new RunVO();
        BeanUtil.copyProperties(entity, vo);
        return vo;
    }
}
