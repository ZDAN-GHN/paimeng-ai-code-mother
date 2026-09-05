package com.zdan.paimengaicodemother.service;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodemother.ai.agent.AgentProperties;
import com.zdan.paimengaicodemother.exception.BusinessException;
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
import static org.mockito.Mockito.*;

/**
 * CreditServiceImpl 单元测试（Mockito mock mapper/依赖，不依赖 Spring 上下文）
 * 覆盖：冻结（成功/幂等/余额不足/金额计算）、结算（成功/幂等）、退款（失败全额/中断全额/中断部分折算）
 * 验收剧本：完成=冻结→结算、失败=冻结→全额退款、中断首文件前=全额退款、中断已写文件=部分退款
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
        when(mapper.update(any(), anyBoolean())).thenReturn(1);
        // IService.updateById → mapper.update(entity, true)；mock 默认 false 会让余额变动判失败
        when(userService.updateById(any())).thenReturn(true);
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

    @Test
    void freeze_success_deductsBalanceAndWritesLedger() {
        when(appService.getById(1L)).thenReturn(htmlApp());
        when(userService.getById(1L)).thenReturn(user(1L, 500));

        CreditFreezeVO vo = service.freeze("run-1", 1L, 1L, "standard");

        assertEquals(100, vo.getFrozenAmount());
        assertEquals(400, vo.getBalance());
        assertNotNull(vo.getLedgerId());
        // 余额扣减 + 台账落库（同事务内两次写）
        verify(userService).updateById(argThat(u -> u.getCredits() == 400));
        verify(mapper).insert(argThat(l -> CreditLedgerStatusEnum.FROZEN.getValue().equals(l.getStatus())
                && l.getFrozenAmount() == 100 && "run-1".equals(l.getRunId())), anyBoolean());
    }

    @Test
    void freeze_calculatesTypeAndIntensityMultipliers() {
        App vueApp = new App();
        vueApp.setId(1L);
        vueApp.setCodeGenType("vue_project");
        when(appService.getById(1L)).thenReturn(vueApp);
        when(userService.getById(1L)).thenReturn(user(1L, 5000));

        // vue_project×3 × deep×2 × base=100 = 600
        CreditFreezeVO vo = service.freeze("run-vue", 1L, 1L, "deep");
        assertEquals(600, vo.getFrozenAmount());
        assertEquals(4400, vo.getBalance());
    }

    @Test
    void freeze_idempotent_returnsExistingLedgerWithoutDoubleDeduct() {
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(userService.getById(1L)).thenReturn(user(1L, 300));

        CreditFreezeVO vo = service.freeze("run-1", 1L, 1L, "standard");

        assertEquals(100, vo.getFrozenAmount());
        assertEquals(300, vo.getBalance());
        verify(mapper, never()).insert(any(), anyBoolean());
        verify(userService, never()).updateById(any());
    }

    @Test
    void freeze_insufficientBalance_throwsCreditNotEnough() {
        when(appService.getById(1L)).thenReturn(htmlApp());
        when(userService.getById(1L)).thenReturn(user(1L, 50));

        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.freeze("run-1", 1L, 1L, "standard"));
        assertEquals(40201, ex.getCode());
        verify(userService, never()).updateById(any());
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

        verify(mapper).update(argThat(l -> CreditLedgerStatusEnum.SETTLED.getValue().equals(l.getStatus())
                && l.getSettleAmount() == 100 && l.getRefundAmount() == 0
                && "complete".equals(l.getReason())), anyBoolean());
        verify(userService, never()).updateById(any());
    }

    @Test
    void settleRun_alreadyTerminal_idempotent() {
        CreditLedger settled = frozenLedger("run-1", 1L, 100);
        settled.setStatus(CreditLedgerStatusEnum.SETTLED.getValue());
        stubLedger(settled);

        service.settleRun("run-1");

        verify(mapper, never()).update(any(), anyBoolean());
        verify(userService, never()).updateById(any());
    }

    // ── 退款：失败全额（失败剧本）──

    @Test
    void refundRun_failed_refundsFullAmount() {
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(userService.getById(1L)).thenReturn(user(1L, 400));

        service.refundRun("run-1", AgentCompleteStatusEnum.FAILED, null, 2);

        verify(userService).updateById(argThat(u -> u.getCredits() == 500));
        verify(mapper).update(argThat(l -> CreditLedgerStatusEnum.REFUNDED.getValue().equals(l.getStatus())
                && l.getRefundAmount() == 100 && l.getSettleAmount() == 0
                && "failed".equals(l.getReason()) && l.getMilestoneCount() == 2), anyBoolean());
    }

    // ── 退款：中断（首文件落盘前 = 全额退款）──

    @Test
    void refundRun_aborted_noFileWritten_refundsFullAmount() {
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(userService.getById(1L)).thenReturn(user(1L, 400));

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 0, 1);

        verify(userService).updateById(argThat(u -> u.getCredits() == 500));
        verify(mapper).update(argThat(l -> CreditLedgerStatusEnum.REFUNDED.getValue().equals(l.getStatus())
                && l.getRefundAmount() == 100 && l.getSettleAmount() == 0
                && "interrupted".equals(l.getReason())), anyBoolean());
    }

    @Test
    void refundRun_aborted_noFileWrittenNull_refundsFullAmount() {
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(userService.getById(1L)).thenReturn(user(1L, 400));

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, null, 1);

        verify(userService).updateById(argThat(u -> u.getCredits() == 500));
        verify(mapper).update(argThat(l -> CreditLedgerStatusEnum.REFUNDED.getValue().equals(l.getStatus())
                && l.getRefundAmount() == 100), anyBoolean());
    }

    // ── 退款：中断（已写文件，未到 review，按基础比例 50% 结算）──

    @Test
    void refundRun_aborted_filesWrittenPartialSettle_basicRatio() {
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(userService.getById(1L)).thenReturn(user(1L, 400));

        // milestoneCount=2（进入 coding，未到 review）：结算 50%，退 50%
        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 2, 2);

        verify(userService).updateById(argThat(u -> u.getCredits() == 450));
        verify(mapper).update(argThat(l -> CreditLedgerStatusEnum.PARTIAL_REFUNDED.getValue().equals(l.getStatus())
                && l.getSettleAmount() == 50 && l.getRefundAmount() == 50
                && "interrupted".equals(l.getReason())), anyBoolean());
    }

    // ── 退款：中断（已写文件，进入 review，按高级比例 70% 结算）──

    @Test
    void refundRun_aborted_filesWrittenPartialSettle_advancedRatio() {
        stubLedger(frozenLedger("run-1", 1L, 100));
        when(userService.getById(1L)).thenReturn(user(1L, 400));

        // milestoneCount=3（已进入 review）：结算 70%，退 30%
        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 2, 3);

        verify(userService).updateById(argThat(u -> u.getCredits() == 430));
        verify(mapper).update(argThat(l -> CreditLedgerStatusEnum.PARTIAL_REFUNDED.getValue().equals(l.getStatus())
                && l.getSettleAmount() == 70 && l.getRefundAmount() == 30), anyBoolean());
    }

    @Test
    void refundRun_noLedger_idempotentSkip() {
        stubLedger(null);

        service.refundRun("run-1", AgentCompleteStatusEnum.ABORTED, 1, 1);

        verify(userService, never()).updateById(any());
        verify(mapper, never()).update(any(), anyBoolean());
    }

    // ── 充值 / 余额 ──

    @Test
    void recharge_increasesBalance() {
        when(userService.getById(1L)).thenReturn(user(1L, 100));

        boolean ok = service.recharge(1L, 200);

        assertTrue(ok);
        verify(userService).updateById(argThat(u -> u.getCredits() == 300));
    }

    @Test
    void recharge_invalidAmount_throws() {
        assertThrows(BusinessException.class, () -> service.recharge(1L, 0));
        assertThrows(BusinessException.class, () -> service.recharge(1L, -10));
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
