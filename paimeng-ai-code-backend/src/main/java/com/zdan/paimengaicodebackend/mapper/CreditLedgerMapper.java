package com.zdan.paimengaicodebackend.mapper;

import com.mybatisflex.core.BaseMapper;
import com.zdan.paimengaicodebackend.model.entity.CreditLedger;
import org.apache.ibatis.annotations.Update;

/**
 * 积分台账（credit_ledger）映射层。
 *
 * @author LXH
 */
public interface CreditLedgerMapper extends BaseMapper<CreditLedger> {

    /**
     * 台账终态原子迁移（Issue #10 审查整改：并发/迟到回调幂等核心）
     * 仅当台账仍处于 FROZEN（可记账态）才迁移 → 并发重复结算/退款只有一个线程 affected=1，
     * 其余 affected=0（幂等跳过，不重复扣费/退款）；同时杜绝「SELECT 状态 → UPDATE」间隙的竞态。
     *
     * @param update 待写入的终态字段（id/status/settleAmount/refundAmount/reason/milestoneCount）
     * @return 受影响行数（0 = 台账已非 FROZEN 或不存在）
     */
    @Update("UPDATE credit_ledger SET status = #{status}, settleAmount = #{settleAmount}, "
            + "refundAmount = #{refundAmount}, reason = #{reason}, milestoneCount = #{milestoneCount}, "
            + "updateTime = NOW() WHERE id = #{id} AND status = 'FROZEN'")
    int transitionIfFrozen(CreditLedger update);
}
