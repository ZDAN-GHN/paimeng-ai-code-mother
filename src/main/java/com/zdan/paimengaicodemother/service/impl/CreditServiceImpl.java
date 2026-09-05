package com.zdan.paimengaicodemother.service.impl;

import cn.hutool.core.util.StrUtil;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodemother.ai.agent.AgentProperties;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.mapper.CreditLedgerMapper;
import com.zdan.paimengaicodemother.model.dto.run.CreditFreezeRequest;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.CreditLedger;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.enums.AgentCompleteStatusEnum;
import com.zdan.paimengaicodemother.model.enums.CreditLedgerStatusEnum;
import com.zdan.paimengaicodemother.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.CreditService;
import com.zdan.paimengaicodemother.service.UserService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 积分台账（credit_ledger）服务层实现。
 * 计费规则（docs/ts_agent/architecture.md §7）：按次 + 档位系数，冻结额 = 基础价 × 生成类型系数 × 强度档系数；
 * 退款折算：失败/中断于首文件落盘前全额退；中断已写文件按里程碑比例部分结算。
 *
 * @author LXH
 */
@Slf4j
@Service
public class CreditServiceImpl extends ServiceImpl<CreditLedgerMapper, CreditLedger>
        implements CreditService {

    /**
     * 里程碑 ≥ 此值视为「已进入质量审查」，中断折算用高结算比例（接近完成的产出价值更高）
     */
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
        // 幂等：同 runId 已冻结（重放/重试）→ 返回既有台账，不重复扣款（uk_runId 兜底）
        CreditLedger existing = getByRunId(runId);
        if (existing != null) {
            log.info("台账已存在，冻结幂等返回，runId: {}, ledgerId: {}", runId, existing.getId());
            return toFreezeVO(existing, getBalance(existing.getUserId()));
        }
        CreditLedger ledger = doFreeze(runId, appId, userId, intensity);
        return toFreezeVO(ledger, getBalance(userId));
    }

    /**
     * 实际冻结动作：计算金额 → 校验并扣减余额 → 写台账
     *
     * @param runId     运行 id
     * @param appId     应用 id（codeGenType 系数来源）
     * @param userId    用户 id（余额归属）
     * @param intensity 推理强度档位
     * @return 新建台账
     */
    private CreditLedger doFreeze(String runId, Long appId, Long userId, String intensity) {
        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "appId 不能为空");
        ThrowUtils.throwIf(userId == null || userId <= 0, ErrorCode.PARAMS_ERROR, "userId 不能为空");
        App app = appService.getById(appId);
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR, "应用不存在");
        User user = userService.getById(userId);
        ThrowUtils.throwIf(user == null, ErrorCode.NOT_FOUND_ERROR, "用户不存在");
        int amount = calcFrozenAmount(app.getCodeGenType(), intensity);
        int balance = user.getCredits() == null ? 0 : user.getCredits();
        ThrowUtils.throwIf(balance < amount, ErrorCode.CREDIT_NOT_ENOUGH,
                "积分不足，当前余额 " + balance + "，本次生成需 " + amount + " 积分，请先充值");
        // 扣减余额并落台账（同事务，保证原子性）
        user.setCredits(balance - amount);
        boolean updated = userService.updateById(user);
        ThrowUtils.throwIf(!updated, ErrorCode.OPERATION_ERROR, "扣减积分失败");
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
        CreditLedger ledger = requireFrozen(runId);
        if (ledger == null) {
            return;
        }
        int frozen = ledger.getFrozenAmount();
        CreditLedger update = CreditLedger.builder()
                .id(ledger.getId())
                .status(CreditLedgerStatusEnum.SETTLED.getValue())
                .settleAmount(frozen)
                .refundAmount(0)
                .reason("complete")
                .build();
        this.updateById(update);
        log.info("积分结算成功，runId: {}, settleAmount: {}", runId, frozen);
    }

    @Override
    @Transactional(rollbackFor = Exception.class)
    public void refundRun(String runId, AgentCompleteStatusEnum status, Integer filesWritten, Integer milestoneCount) {
        CreditLedger ledger = requireFrozen(runId);
        if (ledger == null) {
            return;
        }
        int frozen = ledger.getFrozenAmount();
        Long userId = ledger.getUserId();
        if (status == AgentCompleteStatusEnum.FAILED) {
            // 生成失败 → 全额退款
            refundBalance(userId, frozen);
            CreditLedger update = CreditLedger.builder()
                    .id(ledger.getId())
                    .status(CreditLedgerStatusEnum.REFUNDED.getValue())
                    .settleAmount(0)
                    .refundAmount(frozen)
                    .reason("failed")
                    .milestoneCount(milestoneCount)
                    .build();
            this.updateById(update);
            log.info("失败全额退款，runId: {}, refundAmount: {}", runId, frozen);
            return;
        }
        // aborted：首个文件落盘前（filesWritten ≤ 0）全额退款，否则按里程碑折算部分退款
        boolean noFileWritten = filesWritten == null || filesWritten <= 0;
        if (noFileWritten) {
            refundBalance(userId, frozen);
            CreditLedger update = CreditLedger.builder()
                    .id(ledger.getId())
                    .status(CreditLedgerStatusEnum.REFUNDED.getValue())
                    .settleAmount(0)
                    .refundAmount(frozen)
                    .reason("interrupted")
                    .milestoneCount(milestoneCount)
                    .build();
            this.updateById(update);
            log.info("中断于首文件落盘前，全额退款，runId: {}, refundAmount: {}", runId, frozen);
            return;
        }
        int settle = calcInterruptedSettleAmount(frozen, milestoneCount);
        int refund = frozen - settle;
        refundBalance(userId, refund);
        CreditLedger update = CreditLedger.builder()
                .id(ledger.getId())
                .status(CreditLedgerStatusEnum.PARTIAL_REFUNDED.getValue())
                .settleAmount(settle)
                .refundAmount(refund)
                .reason("interrupted")
                .milestoneCount(milestoneCount)
                .build();
        this.updateById(update);
        log.info("中断折算退款，runId: {}, settleAmount: {}, refundAmount: {}", runId, settle, refund);
    }

    @Override
    public boolean recharge(Long userId, int credits) {
        ThrowUtils.throwIf(userId == null || userId <= 0, ErrorCode.PARAMS_ERROR, "userId 不能为空");
        ThrowUtils.throwIf(credits <= 0, ErrorCode.PARAMS_ERROR, "充值积分数必须为正数");
        User user = userService.getById(userId);
        ThrowUtils.throwIf(user == null, ErrorCode.NOT_FOUND_ERROR, "用户不存在");
        int balance = user.getCredits() == null ? 0 : user.getCredits();
        user.setCredits(balance + credits);
        boolean updated = userService.updateById(user);
        ThrowUtils.throwIf(!updated, ErrorCode.OPERATION_ERROR, "充值失败");
        log.info("积分充值成功，userId: {}, amount: {}, balance: {}", userId, credits, user.getCredits());
        return true;
    }

    @Override
    public int getBalance(Long userId) {
        ThrowUtils.throwIf(userId == null || userId <= 0, ErrorCode.PARAMS_ERROR, "userId 不能为空");
        User user = userService.getById(userId);
        ThrowUtils.throwIf(user == null, ErrorCode.NOT_FOUND_ERROR, "用户不存在");
        return user.getCredits() == null ? 0 : user.getCredits();
    }

    @Override
    public CreditLedger getByRunId(String runId) {
        if (StrUtil.isBlank(runId)) {
            return null;
        }
        return this.getOne(new com.mybatisflex.core.query.QueryWrapper()
                .eq(CreditLedger::getRunId, runId));
    }

    /**
     * 读取台账并要求仍处于可记账的冻结态（已终态 → 幂等返回 null，不重复记账）
     *
     * @param runId 运行 id
     * @return 冻结态台账；不存在或已终态返回 null
     */
    private CreditLedger requireFrozen(String runId) {
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

    /**
     * 退款加回用户余额
     *
     * @param userId 用户 id
     * @param amount 退款积分数
     */
    private void refundBalance(Long userId, int amount) {
        User user = userService.getById(userId);
        if (user == null) {
            log.error("退款用户不存在，userId: {}, amount: {}", userId, amount);
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "退款用户不存在");
        }
        int balance = user.getCredits() == null ? 0 : user.getCredits();
        user.setCredits(balance + amount);
        boolean updated = userService.updateById(user);
        ThrowUtils.throwIf(!updated, ErrorCode.OPERATION_ERROR, "退款失败");
    }

    /**
     * 计算冻结积分：基础价 × 生成类型系数 × 强度档位系数
     *
     * @param codeGenType 生成类型（html/multi_file/vue_project）
     * @param intensity   推理强度档位（fast/standard/deep，与 TS Agent INTENSITY_TIERS 对齐）
     * @return 冻结积分数
     */
    private int calcFrozenAmount(String codeGenType, String intensity) {
        AgentProperties.Credit credit = agentProperties.getCredit();
        int base = credit.getBasePrice();
        int typeMultiplier = switch (CodeGenTypeEnum.getEnumByValue(codeGenType)) {
            case CodeGenTypeEnum.MULTI_FILE -> credit.getMultiFileMultiplier();
            case CodeGenTypeEnum.VUE_PROJECT -> credit.getVueProjectMultiplier();
            default -> credit.getHtmlMultiplier();
        };
        int tierMultiplier = switch (StrUtil.blankToDefault(intensity, "standard")) {
            case "fast" -> credit.getFastMultiplier();
            case "deep" -> credit.getDeepMultiplier();
            default -> credit.getStandardMultiplier();
        };
        return base * typeMultiplier * tierMultiplier;
    }

    /**
     * 中断已写文件后的结算额：已进入质量审查（里程碑 ≥ 阈值）用高比例，否则用基础比例
     *
     * @param frozen         冻结积分数
     * @param milestoneCount 已过里程碑数
     * @return 结算积分数（四舍五入）
     */
    private int calcInterruptedSettleAmount(int frozen, Integer milestoneCount) {
        AgentProperties.Credit credit = agentProperties.getCredit();
        double ratio = milestoneCount != null && milestoneCount >= REVIEW_MILESTONE_THRESHOLD
                ? credit.getInterruptedAdvancedSettleRatio()
                : credit.getInterruptedBasicSettleRatio();
        return (int) Math.round(frozen * ratio);
    }

    /**
     * 台账转冻结视图
     *
     * @param ledger  台账
     * @param balance 用户当前余额
     * @return 视图
     */
    private CreditFreezeVO toFreezeVO(CreditLedger ledger, int balance) {
        CreditFreezeVO vo = new CreditFreezeVO();
        vo.setLedgerId(ledger.getId());
        vo.setFrozenAmount(ledger.getFrozenAmount());
        vo.setBalance(balance);
        return vo;
    }
}
