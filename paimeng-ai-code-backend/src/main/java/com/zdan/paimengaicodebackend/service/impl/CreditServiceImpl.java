package com.zdan.paimengaicodebackend.service.impl;

import cn.hutool.core.util.StrUtil;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodebackend.ai.agent.AgentProperties;
import com.zdan.paimengaicodebackend.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.exception.ThrowUtils;
import com.zdan.paimengaicodebackend.mapper.CreditLedgerMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.CreditLedger;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.model.enums.AgentCompleteStatusEnum;
import com.zdan.paimengaicodebackend.model.enums.AgentIntensityEnum;
import com.zdan.paimengaicodebackend.model.enums.CreditLedgerStatusEnum;
import com.zdan.paimengaicodebackend.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodebackend.service.AppService;
import com.zdan.paimengaicodebackend.service.CreditService;
import com.zdan.paimengaicodebackend.service.UserService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;


@Slf4j
@Service
public class CreditServiceImpl extends ServiceImpl<CreditLedgerMapper, CreditLedger>
        implements CreditService {


    private static final int REVIEW_MILESTONE_THRESHOLD = 3;

    private final AppService appService;
    private final UserService userService;
    private final AgentProperties agentProperties;

    public CreditServiceImpl(AppService appService, UserService userService, AgentProperties agentProperties) {
        this.appService = appService;
        this.userService = userService;
        this.agentProperties = agentProperties;
    }

    @Override
    @Transactional(rollbackFor = Exception.class)
    public CreditFreezeVO freeze(String runId, Long appId, Long userId, String intensity) {
        ThrowUtils.throwIf(StrUtil.isBlank(runId), ErrorCode.PARAMS_ERROR, "runId 不能为空");

        CreditLedger existing = getByRunId(runId);
        if (existing != null) {
            log.info("台账已存在，冻结幂等返回，runId: {}, ledgerId: {}", runId, existing.getId());
            return buildFreezeVO(existing);
        }
        CreditLedger ledger = doFreeze(runId, appId, userId, intensity);
        return buildFreezeVO(ledger);
    }


    private CreditLedger doFreeze(String runId, Long appId, Long userId, String intensity) {
        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "appId 不能为空");
        ThrowUtils.throwIf(userId == null || userId <= 0, ErrorCode.PARAMS_ERROR, "userId 不能为空");
        App app = appService.getById(appId);
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR, "应用不存在");
        User user = userService.getById(userId);
        ThrowUtils.throwIf(user == null, ErrorCode.NOT_FOUND_ERROR, "用户不存在");
        int amount = calcFrozenAmount(app.getCodeGenType(), intensity);

        int affected = userService.deductCredits(userId, amount);
        if (affected == 0) {
            int balance = balanceOf(user);
            throw new BusinessException(ErrorCode.CREDIT_NOT_ENOUGH,
                    "积分不足，当前余额 " + balance + "，本次生成需 " + amount + " 积分，请先充值");
        }
        CreditLedger ledger = CreditLedger.builder()
                .runId(runId)
                .userId(userId)
                .appId(appId)
                .status(CreditLedgerStatusEnum.FROZEN.getValue())
                .frozenAmount(amount)
                .build();
        boolean saved = this.save(ledger);
        ThrowUtils.throwIf(!saved, ErrorCode.OPERATION_ERROR, "创建积分台账失败");
        log.info("积分冻结成功，runId: {}, userId: {}, frozenAmount: {}", runId, userId, amount);
        return ledger;
    }

    @Override
    @Transactional(rollbackFor = Exception.class)
    public void settleRun(String runId) {
        CreditLedger ledger = getFrozenOrNull(runId);
        if (ledger == null) {
            return;
        }
        int frozen = ledger.getFrozenAmount();
        CreditLedger update = CreditLedger.builder()
                .id(ledger.getId())
                .status(CreditLedgerStatusEnum.SETTLED.getValue())
                .settleAmount(frozen)
                .refundAmount(0)
                .reason(AgentCompleteStatusEnum.SUCCESS.getReason())
                .build();

        int affected = this.mapper.transitionIfFrozen(update);
        if (affected == 0) {
            log.info("台账非冻结态，结算幂等跳过，runId: {}", runId);
            return;
        }
        log.info("积分结算成功，runId: {}, settleAmount: {}", runId, frozen);
    }

    @Override
    @Transactional(rollbackFor = Exception.class)
    public void refundRun(String runId, AgentCompleteStatusEnum status, Integer filesWritten, Integer milestoneCount) {
        CreditLedger ledger = getFrozenOrNull(runId);
        if (ledger == null) {
            return;
        }
        int frozen = ledger.getFrozenAmount();
        Long userId = ledger.getUserId();
        CreditLedger update;
        int refundAmount;
        if (status == AgentCompleteStatusEnum.FAILED) {

            refundAmount = frozen;
            update = CreditLedger.builder()
                    .id(ledger.getId())
                    .status(CreditLedgerStatusEnum.REFUNDED.getValue())
                    .settleAmount(0)
                    .refundAmount(frozen)
                    .reason(status.getReason())
                    .milestoneCount(milestoneCount)
                    .build();
        } else {


            boolean noFileWritten = filesWritten == null || filesWritten <= 0;
            if (noFileWritten) {
                refundAmount = frozen;
                update = CreditLedger.builder()
                        .id(ledger.getId())
                        .status(CreditLedgerStatusEnum.REFUNDED.getValue())
                        .settleAmount(0)
                        .refundAmount(frozen)
                        .reason(status.getReason())
                        .milestoneCount(milestoneCount)
                        .build();
            } else {
                int settle = calcInterruptedSettleAmount(frozen, milestoneCount);
                refundAmount = frozen - settle;
                update = CreditLedger.builder()
                        .id(ledger.getId())
                        .status(CreditLedgerStatusEnum.PARTIAL_REFUNDED.getValue())
                        .settleAmount(settle)
                        .refundAmount(refundAmount)
                        .reason(status.getReason())
                        .milestoneCount(milestoneCount)
                        .build();
            }
        }

        int affected = this.mapper.transitionIfFrozen(update);
        if (affected == 0) {
            log.info("台账非冻结态，退款幂等跳过，runId: {}", runId);
            return;
        }
        if (refundAmount > 0) {
            refundBalance(userId, refundAmount);
        }
        log.info("退款成功，runId: {}, status: {}, settleAmount: {}, refundAmount: {}",
                runId, status, update.getSettleAmount(), refundAmount);
    }

    @Override
    public void recharge(Long userId, int credits) {
        ThrowUtils.throwIf(userId == null || userId <= 0, ErrorCode.PARAMS_ERROR, "userId 不能为空");
        ThrowUtils.throwIf(credits <= 0, ErrorCode.PARAMS_ERROR, "充值积分数必须为正数");
        User user = userService.getById(userId);
        ThrowUtils.throwIf(user == null, ErrorCode.NOT_FOUND_ERROR, "用户不存在");

        int affected = userService.addCredits(userId, credits);
        ThrowUtils.throwIf(affected == 0, ErrorCode.OPERATION_ERROR, "充值失败");
        log.info("积分充值成功，userId: {}, amount: {}, balance: {}", userId, credits, balanceOf(user) + credits);
    }

    @Override
    public int getBalance(Long userId) {
        ThrowUtils.throwIf(userId == null || userId <= 0, ErrorCode.PARAMS_ERROR, "userId 不能为空");
        User user = userService.getById(userId);
        ThrowUtils.throwIf(user == null, ErrorCode.NOT_FOUND_ERROR, "用户不存在");
        return balanceOf(user);
    }

    @Override
    public CreditLedger getByRunId(String runId) {
        if (StrUtil.isBlank(runId)) {
            return null;
        }
        return this.getOne(new com.mybatisflex.core.query.QueryWrapper()
                .eq(CreditLedger::getRunId, runId));
    }

    @Override
    public CreditFreezeVO buildFreezeVO(CreditLedger ledger) {
        CreditFreezeVO vo = new CreditFreezeVO();
        vo.setLedgerId(ledger.getId());
        vo.setFrozenAmount(ledger.getFrozenAmount());
        vo.setBalance(getBalance(ledger.getUserId()));
        return vo;
    }


    private CreditLedger getFrozenOrNull(String runId) {
        CreditLedger ledger = getByRunId(runId);
        if (ledger == null) {
            log.warn("台账不存在（未冻结），幂等跳过记账，runId: {}", runId);
            return null;
        }
        CreditLedgerStatusEnum statusEnum = CreditLedgerStatusEnum.getEnumByValue(ledger.getStatus());
        if (statusEnum != CreditLedgerStatusEnum.FROZEN) {
            log.info("台账已终态（{}），幂等跳过，runId: {}", ledger.getStatus(), runId);
            return null;
        }
        return ledger;
    }


    private void refundBalance(Long userId, int amount) {
        int affected = userService.addCredits(userId, amount);
        if (affected == 0) {
            log.error("退款用户不存在，userId: {}, amount: {}", userId, amount);
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "退款用户不存在");
        }
    }


    private int calcFrozenAmount(String codeGenType, String intensity) {
        AgentProperties.Credit credit = agentProperties.getCredit();
        int base = credit.getBasePrice();
        int typeMultiplier = switch (CodeGenTypeEnum.getEnumByValue(codeGenType)) {
            case CodeGenTypeEnum.MULTI_FILE -> credit.getMultiFileMultiplier();
            case CodeGenTypeEnum.VUE_PROJECT -> credit.getVueProjectMultiplier();
            default -> credit.getHtmlMultiplier();
        };
        AgentIntensityEnum tier = AgentIntensityEnum.getEnumByValue(intensity);
        if (tier == null) {

            tier = AgentIntensityEnum.STANDARD;
        }

        double tierMultiplier = switch (tier) {
            case FAST -> credit.getFastMultiplier();
            case DEEP -> credit.getDeepMultiplier();
            default -> credit.getStandardMultiplier();
        };
        return (int) Math.round(base * typeMultiplier * tierMultiplier);
    }


    private int calcInterruptedSettleAmount(int frozen, Integer milestoneCount) {
        AgentProperties.Credit credit = agentProperties.getCredit();
        double ratio = milestoneCount != null && milestoneCount >= REVIEW_MILESTONE_THRESHOLD
                ? credit.getInterruptedAdvancedSettleRatio()
                : credit.getInterruptedBasicSettleRatio();
        return (int) Math.round(frozen * ratio);
    }


    private static int balanceOf(User user) {
        return user == null || user.getCredits() == null ? 0 : user.getCredits();
    }
}
