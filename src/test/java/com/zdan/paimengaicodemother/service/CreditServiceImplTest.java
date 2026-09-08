package com.zdan.paimengaicodemother.service;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodemother.ai.agent.AgentProperties;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.mapper.CreditLedgerMapper;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.CreditLedger;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.enums.AgentCompleteStatusEnum;
import com.zdan.paimengaicodemother.model.enums.CreditLedgerStatusEnum;
import com.zdan.paimengaicodemother.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodemother.service.impl.CreditServiceImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/**
 * CreditServiceImpl 单元测试（Mockito mock mapper/依赖，不依赖 Spring 上下文）
 * 覆盖：冻结（成功/幂等/余额不足/金额计算/非法强度兜底）、结算（成功/幂等/条件更新）、
 * 退款（失败全额/中断全额/中断部分折算/条件更新失败不加钱/退款用户不存在）、充值/余额。
 * 验收剧本：完成=冻结→结算、失败=冻结→全额退款、中断首文件前=全额退款、中断已写文件=部分退款；
 * 并发/幂等（Issue #10 审查整改）：余额原子 SQL + 台账 FROZEN→终态条件更新。
 *
 * @author LXH
 */
class CreditServiceImplTest {

    private CreditLedgerMapper mapper;
    private AppService appService;
    private UserService userService;
    private AgentProperties properties;
    private CreditServiceImpl service;

    @BeforeEach
    void setUp() {
        mapper = mock(CreditLedgerMapper.class);
        appService = mock(AppService.class);
        userService = mock(UserService.class);
        properties = new AgentProperties();
        service = new CreditServiceImpl(appService, userService, properties);
        ReflectionTestUtils.setField(service, "mapper", mapper);
        when(mapper.insert(any(), anyBoolean())).thenAnswer(inv -> {
            // 模拟数据库自增主键回填，让 vo.getLedgerId() 可用
            CreditLedger entity = inv.getArgument(0);
            if (entity.getId() == null) {
                entity.setId(99L);
            }
            return 1;
        });
        // 台账 FROZEN→终态条件更新默认成功（并发失败的用例单独 stub 返回 0）
        when(mapper.transitionIfFrozen(any())).thenReturn(1);
        // 余额原子 SQL 默认成功（余额不足/用户缺失用例单独 stub 返回 0）
        when(userService.deductCredits(anyLong(), anyInt())).thenReturn(1);
        when(userService.addCredits(anyLong(), anyInt())).thenReturn(1);
    }

    private User user(long id, int credits) {
        User user = new User();
        user.setId(id);
        user.setCredits(credits);
        return user;
    }

    private App htmlApp() {
        App app = new App();
        app.setId(1L);
        app.setCodeGenType("html");
        return app;
    }

    // 默认配置：base=100，html×1，standard×1 → 冻结 100
    private CreditLedger frozenLedger(String runId, long userId, int amount) {
        return CreditLedger.builder()
                .id(1L)
                .runId(runId)
                .userId(userId)
                .appId(1L)
                .status(CreditLedgerStatusEnum.FROZEN.getValue())
                .frozenAmount(amount)
                .build();
    }

    private void stubLedger(CreditLedger ledger) {
        when(mapper.selectOneByQuery(any(QueryWrapper.class))).thenReturn(ledger);
    }

    // ── 冻结 ──

    @Test
    void freeze_success_deductsBalanceAndWritesLedger() {
        when(appService.getById(1L)).thenReturn(htmlApp());
        // 冻结后余额（buildFreezeVO 二次读库语义：mock 固定返回扣减后值）
        when(userService.getById(1L)).thenReturn(user(1L, 400));

        CreditFreezeVO vo = service.freeze("run-1", 1L, 1L, "standard");

        assertEquals(100, vo.getFrozenAmount());
        assertEquals(400, vo.getBalance());
        assertNotNull(vo.getLedgerId());
        // 原子扣减 + 台账落库（同事务内两次写）
        verify(userService).deductCredits(1L, 100);
        verify(mapper).insert(argThat(l -> CreditLedgerStatusEnum.FROZEN.getValue().equals(l.getStatus())
                && l.getFrozenAmount() == 100 && "run-1".equals(l.getRunId())), anyBoolean());
    }

    @Test
    void freeze_calculatesTypeAndIntensityMultipliers() {
        App vueApp = new App();
        vueApp.setId(1L);
        vueApp.setCodeGenType("vue_project");
        when(appService.getById(1L)).thenReturn(vueApp);
        // 冻结后余额 = 5000 - 600
        when(userService.getById(1L)).thenReturn(user(1L, 4400));

        // vue_project×3 × deep×2 × base=100 = 600
        CreditFreezeVO vo = service.freeze("run-vue", 1L, 1L, "deep");
        assertEquals(600, vo.getFrozenAmount());
        assertEquals(4400, vo.getBalance());
        verify(userService).deductCredits(1L, 600);
    }

    @Test
    void freeze_fastTier_discountsHalfPrice() {
        when(appService.getById(1L)).thenReturn(htmlApp());
        // 冻结后余额 = 5000 - 50
        when(userService.getById(1L)).thenReturn(user(1L, 4950));

        // html×1 × fast×0.5 × base=100 = 50（快速档半价折扣）
        CreditFreezeVO vo = service.freeze("run-fast", 1L, 1L, "fast");
        assertEquals(50, vo.getFrozenAmount());
        assertEquals(4950, vo.getBalance());
        verify(userService).deductCredits(1L, 50);
    }

    @Test
    void freeze_invalidIntensity_fallsBackToStandard() {
        when(appService.getById(1L)).thenReturn(htmlApp());
        when(userService.getById(1L)).thenReturn(user(1L, 400));

        // 非法/空档位按标准档（×1），冻结 100
        CreditFreezeVO vo = service.freeze("run-1", 1L, 1L, "ultra");
        assertEquals(100, vo.getFrozenAmount());
        verify(userService).deductCredits(1L, 100);
    }

    @Test
    void freeze_idempotent_returnsExistingLedgerWithoutDoubleDeduct() {
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(userService.getById(1L)).thenReturn(user(1L, 300));

        CreditFreezeVO vo = service.freeze("run-1", 1L, 1L, "standard");

        assertEquals(100, vo.getFrozenAmount());
        assertEquals(300, vo.getBalance());
        verify(mapper, never()).insert(any(), anyBoolean());
        verify(userService, never()).deductCredits(anyLong(), anyInt());
    }

    @Test
    void freeze_insufficientBalance_throwsCreditNotEnough() {
        when(appService.getById(1L)).thenReturn(htmlApp());
        when(userService.getById(1L)).thenReturn(user(1L, 50));
        // DB 层判定余额不足 → affected=0（并发下也不会超扣）
        when(userService.deductCredits(1L, 100)).thenReturn(0);

        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.freeze("run-1", 1L, 1L, "standard"));
        assertEquals(40201, ex.getCode());
        assertEquals("积分不足，当前余额 50，本次生成需 100 积分，请先充值", ex.getMessage());
        verify(mapper, never()).insert(any(), anyBoolean());
    }

    @Test
    void freeze_appNotFound_throws() {
        when(appService.getById(1L)).thenReturn(null);
        assertThrows(BusinessException.class, () -> service.freeze("run-1", 1L, 1L, "standard"));
    }

    // ── 结算：冻结 → 结算（完成剧本）──

    @Test
    void settleRun_movesFrozenToSettled_fullSettle() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        service.settleRun("run-1");

        verify(mapper).transitionIfFrozen(argThat(l -> CreditLedgerStatusEnum.SETTLED.getValue().equals(l.getStatus())
                && l.getSettleAmount() == 100 && l.getRefundAmount() == 0
                && "complete".equals(l.getReason())));
        verify(userService, never()).addCredits(anyLong(), anyInt());
    }

    @Test
    void settleRun_alreadyTerminal_idempotent() {
        CreditLedger settled = frozenLedger("run-1", 1L, 100);
        settled.setStatus(CreditLedgerStatusEnum.SETTLED.getValue());
        stubLedger(settled);

        service.settleRun("run-1");

        verify(mapper, never()).transitionIfFrozen(any());
        verify(userService, never()).addCredits(anyLong(), anyInt());
    }

    @Test
    void settleRun_transitionLost_skipsIdempotently() {
        // 并发：另一线程已把台账从 FROZEN 迁移 → 本线程条件更新 affected=0，静默幂等跳过
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(mapper.transitionIfFrozen(any())).thenReturn(0);

        service.settleRun("run-1");

        verify(mapper).transitionIfFrozen(any());
        verify(userService, never()).addCredits(anyLong(), anyInt());
    }

    // ── 退款：失败全额（失败剧本）──

    @Test
    void refundRun_failed_refundsFullAmount() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        service.refundRun("run-1", AgentCompleteStatusEnum.FAILED, null, 2);

        verify(userService).addCredits(1L, 100);
        verify(mapper).transitionIfFrozen(argThat(l -> CreditLedgerStatusEnum.REFUNDED.getValue().equals(l.getStatus())
                && l.getRefundAmount() == 100 && l.getSettleAmount() == 0
                && "failed".equals(l.getReason()) && l.getMilestoneCount() == 2));
    }

    // ── 退款：中断（首文件落盘前 = 全额退款）──

    @Test
    void refundRun_aborted_noFileWritten_refundsFullAmount() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 0, 1);

        verify(userService).addCredits(1L, 100);
        verify(mapper).transitionIfFrozen(argThat(l -> CreditLedgerStatusEnum.REFUNDED.getValue().equals(l.getStatus())
                && l.getRefundAmount() == 100 && l.getSettleAmount() == 0
                && "interrupted".equals(l.getReason())));
    }

    @Test
    void refundRun_aborted_noFileWrittenNull_refundsFullAmount() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, null, 1);

        verify(userService).addCredits(1L, 100);
        verify(mapper).transitionIfFrozen(argThat(l -> CreditLedgerStatusEnum.REFUNDED.getValue().equals(l.getStatus())
                && l.getRefundAmount() == 100));
    }

    // ── 退款：中断（已写文件，未到 review，按基础比例 50% 结算）──

    @Test
    void refundRun_aborted_filesWrittenPartialSettle_basicRatio() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        // milestoneCount=2（进入 coding，未到 review）：结算 50%，退 50%
        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 2, 2);

        verify(userService).addCredits(1L, 50);
        verify(mapper).transitionIfFrozen(argThat(l -> CreditLedgerStatusEnum.PARTIAL_REFUNDED.getValue().equals(l.getStatus())
                && l.getSettleAmount() == 50 && l.getRefundAmount() == 50
                && "interrupted".equals(l.getReason())));
    }

    // ── 退款：中断（已写文件，进入 review，按高级比例 70% 结算）──

    @Test
    void refundRun_aborted_filesWrittenPartialSettle_advancedRatio() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        // milestoneCount=3（已进入 review）：结算 70%，退 30%
        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 2, 3);

        verify(userService).addCredits(1L, 30);
        verify(mapper).transitionIfFrozen(argThat(l -> CreditLedgerStatusEnum.PARTIAL_REFUNDED.getValue().equals(l.getStatus())
                && l.getSettleAmount() == 70 && l.getRefundAmount() == 30));
    }

    @Test
    void refundRun_noLedger_idempotentSkip() {
        stubLedger(null);

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 1, 1);

        verify(userService, never()).addCredits(anyLong(), anyInt());
        verify(mapper, never()).transitionIfFrozen(any());
    }

    // ── 退款并发：条件更新失败不加钱（防并发双重退款）──

    @Test
    void refundRun_transitionLost_doesNotRefundBalance() {
        stubLedger(frozenLedger("run-1", 1L, 100));
        // 并发：另一线程已赢得 FROZEN→终态迁移 → 本线程 affected=0，不得再加钱（不双倍退）
        when(mapper.transitionIfFrozen(any())).thenReturn(0);

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 2, 2);

        verify(userService, never()).addCredits(anyLong(), anyInt());
    }

    @Test
    void refundRun_userMissingAfterTransition_throwsNotFound() {
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(userService.addCredits(1L, 100)).thenReturn(0);

        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.refundRun("run-1", AgentCompleteStatusEnum.FAILED, null, 1));
        assertEquals(ErrorCode.NOT_FOUND_ERROR.getCode(), ex.getCode());
        assertEquals("退款用户不存在", ex.getMessage());
    }

    // ── 充值 / 余额 ──

    @Test
    void recharge_increasesBalance() {
        when(userService.getById(1L)).thenReturn(user(1L, 100));

        service.recharge(1L, 200);

        verify(userService).addCredits(1L, 200);
    }

    @Test
    void recharge_invalidAmount_throws() {
        assertThrows(BusinessException.class, () -> service.recharge(1L, 0));
        assertThrows(BusinessException.class, () -> service.recharge(1L, -10));
    }

    @Test
    void recharge_userMissing_throws() {
        when(userService.getById(1L)).thenReturn(null);
        BusinessException ex = assertThrows(BusinessException.class, () -> service.recharge(1L, 100));
        assertEquals("用户不存在", ex.getMessage());
        verify(userService, never()).addCredits(anyLong(), anyInt());
    }

    @Test
    void getBalance_returnsCredits() {
        when(userService.getById(1L)).thenReturn(user(1L, 320));
        assertEquals(320, service.getBalance(1L));
    }

    @Test
    void getBalance_userMissing_throws() {
        when(userService.getById(1L)).thenReturn(null);
        assertThrows(BusinessException.class, () -> service.getBalance(1L));
    }
}
