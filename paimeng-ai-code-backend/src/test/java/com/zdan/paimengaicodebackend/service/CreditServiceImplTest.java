package com.zdan.paimengaicodebackend.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.ai.agent.AgentProperties;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.CreditLedgerMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.CreditLedger;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.model.enums.AgentCompleteStatusEnum;
import com.zdan.paimengaicodebackend.model.enums.CreditLedgerStatusEnum;
import com.zdan.paimengaicodebackend.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodebackend.service.impl.CreditServiceImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

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
            CreditLedger entity = inv.getArgument(0);
            if (entity.getId() == null) {
                entity.setId(99L);
            }
            return 1;
        });

        when(mapper.transitionIfFrozen(any())).thenReturn(1);
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

    @Test
    void freeze_success_deductsBalanceAndWritesLedger() {
        when(appService.getById(1L)).thenReturn(htmlApp());
        when(userService.getById(1L)).thenReturn(user(1L, 400));

        CreditFreezeVO vo = service.freeze("run-1", 1L, 1L, "standard");

        assertEquals(100, vo.getFrozenAmount());
        assertEquals(400, vo.getBalance());
        assertNotNull(vo.getLedgerId());
        verify(userService).deductCredits(1L, 100);
        verify(mapper).insert(
            argThat(
                l ->
                    CreditLedgerStatusEnum.FROZEN.getValue().equals(l.getStatus()) &&
                    l.getFrozenAmount() == 100 &&
                    "run-1".equals(l.getRunId())
            ),
            anyBoolean()
        );
    }

    @Test
    void freeze_calculatesTypeAndIntensityMultipliers() {
        App vueApp = new App();
        vueApp.setId(1L);
        vueApp.setCodeGenType("vue_project");
        when(appService.getById(1L)).thenReturn(vueApp);
        when(userService.getById(1L)).thenReturn(user(1L, 4400));

        CreditFreezeVO vo = service.freeze("run-vue", 1L, 1L, "deep");
        assertEquals(600, vo.getFrozenAmount());
        assertEquals(4400, vo.getBalance());
        verify(userService).deductCredits(1L, 600);
    }

    @Test
    void freeze_fastTier_discountsHalfPrice() {
        when(appService.getById(1L)).thenReturn(htmlApp());
        when(userService.getById(1L)).thenReturn(user(1L, 4950));

        CreditFreezeVO vo = service.freeze("run-fast", 1L, 1L, "fast");
        assertEquals(50, vo.getFrozenAmount());
        assertEquals(4950, vo.getBalance());
        verify(userService).deductCredits(1L, 50);
    }

    @Test
    void freeze_invalidIntensity_fallsBackToStandard() {
        when(appService.getById(1L)).thenReturn(htmlApp());
        when(userService.getById(1L)).thenReturn(user(1L, 400));

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
        when(userService.deductCredits(1L, 100)).thenReturn(0);

        BusinessException ex = assertThrows(BusinessException.class, () ->
            service.freeze("run-1", 1L, 1L, "standard")
        );
        assertEquals(40201, ex.getCode());
        assertEquals("积分不足，当前余额 50，本次生成需 100 积分，请先充值", ex.getMessage());
        verify(mapper, never()).insert(any(), anyBoolean());
    }

    @Test
    void freeze_appNotFound_throws() {
        when(appService.getById(1L)).thenReturn(null);
        assertThrows(BusinessException.class, () -> service.freeze("run-1", 1L, 1L, "standard"));
    }

    @Test
    void settleRun_movesFrozenToSettled_fullSettle() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        service.settleRun("run-1");

        verify(mapper).transitionIfFrozen(
            argThat(
                l ->
                    CreditLedgerStatusEnum.SETTLED.getValue().equals(l.getStatus()) &&
                    l.getSettleAmount() == 100 &&
                    l.getRefundAmount() == 0 &&
                    "complete".equals(l.getReason())
            )
        );
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
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(mapper.transitionIfFrozen(any())).thenReturn(0);

        service.settleRun("run-1");

        verify(mapper).transitionIfFrozen(any());
        verify(userService, never()).addCredits(anyLong(), anyInt());
    }

    @Test
    void refundRun_failed_refundsFullAmount() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        service.refundRun("run-1", AgentCompleteStatusEnum.FAILED, null, 2);

        verify(userService).addCredits(1L, 100);
        verify(mapper).transitionIfFrozen(
            argThat(
                l ->
                    CreditLedgerStatusEnum.REFUNDED.getValue().equals(l.getStatus()) &&
                    l.getRefundAmount() == 100 &&
                    l.getSettleAmount() == 0 &&
                    "failed".equals(l.getReason()) &&
                    l.getMilestoneCount() == 2
            )
        );
    }

    @Test
    void refundRun_aborted_noFileWritten_refundsFullAmount() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 0, 1);

        verify(userService).addCredits(1L, 100);
        verify(mapper).transitionIfFrozen(
            argThat(
                l ->
                    CreditLedgerStatusEnum.REFUNDED.getValue().equals(l.getStatus()) &&
                    l.getRefundAmount() == 100 &&
                    l.getSettleAmount() == 0 &&
                    "interrupted".equals(l.getReason())
            )
        );
    }

    @Test
    void refundRun_aborted_noFileWrittenNull_refundsFullAmount() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, null, 1);

        verify(userService).addCredits(1L, 100);
        verify(mapper).transitionIfFrozen(
            argThat(
                l ->
                    CreditLedgerStatusEnum.REFUNDED.getValue().equals(l.getStatus()) &&
                    l.getRefundAmount() == 100
            )
        );
    }

    @Test
    void refundRun_aborted_filesWrittenPartialSettle_basicRatio() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 2, 2);

        verify(userService).addCredits(1L, 50);
        verify(mapper).transitionIfFrozen(
            argThat(
                l ->
                    CreditLedgerStatusEnum.PARTIAL_REFUNDED.getValue().equals(l.getStatus()) &&
                    l.getSettleAmount() == 50 &&
                    l.getRefundAmount() == 50 &&
                    "interrupted".equals(l.getReason())
            )
        );
    }

    @Test
    void refundRun_aborted_filesWrittenPartialSettle_advancedRatio() {
        stubLedger(frozenLedger("run-1", 1L, 100));

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 2, 3);

        verify(userService).addCredits(1L, 30);
        verify(mapper).transitionIfFrozen(
            argThat(
                l ->
                    CreditLedgerStatusEnum.PARTIAL_REFUNDED.getValue().equals(l.getStatus()) &&
                    l.getSettleAmount() == 70 &&
                    l.getRefundAmount() == 30
            )
        );
    }

    @Test
    void refundRun_noLedger_idempotentSkip() {
        stubLedger(null);

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 1, 1);

        verify(userService, never()).addCredits(anyLong(), anyInt());
        verify(mapper, never()).transitionIfFrozen(any());
    }

    @Test
    void refundRun_transitionLost_doesNotRefundBalance() {
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(mapper.transitionIfFrozen(any())).thenReturn(0);

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 2, 2);

        verify(userService, never()).addCredits(anyLong(), anyInt());
    }

    @Test
    void refundRun_userMissingAfterTransition_throwsNotFound() {
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(userService.addCredits(1L, 100)).thenReturn(0);

        BusinessException ex = assertThrows(BusinessException.class, () ->
            service.refundRun("run-1", AgentCompleteStatusEnum.FAILED, null, 1)
        );
        assertEquals(ErrorCode.NOT_FOUND_ERROR.getCode(), ex.getCode());
        assertEquals("退款用户不存在", ex.getMessage());
    }

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
        BusinessException ex = assertThrows(BusinessException.class, () ->
            service.recharge(1L, 100)
        );
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
