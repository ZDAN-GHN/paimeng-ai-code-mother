package com.zdan.paimengaicodebackend.mapper;

import com.mybatisflex.core.BaseMapper;
import com.zdan.paimengaicodebackend.model.entity.CreditLedger;
import org.apache.ibatis.annotations.Update;


public interface CreditLedgerMapper extends BaseMapper<CreditLedger> {


    @Update("UPDATE credit_ledger SET status = #{status}, settleAmount = #{settleAmount}, "
            + "refundAmount = #{refundAmount}, reason = #{reason}, milestoneCount = #{milestoneCount}, "
            + "updateTime = NOW() WHERE id = #{id} AND status = 'FROZEN'")
    int transitionIfFrozen(CreditLedger update);
}
