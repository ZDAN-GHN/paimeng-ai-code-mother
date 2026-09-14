package com.zdan.paimengaicodebackend.service;

import com.mybatisflex.core.service.IService;
import com.zdan.paimengaicodebackend.model.dto.run.CreditFreezeRequest;
import com.zdan.paimengaicodebackend.model.entity.CreditLedger;
import com.zdan.paimengaicodebackend.model.enums.AgentCompleteStatusEnum;
import com.zdan.paimengaicodebackend.model.vo.CreditFreezeVO;


public interface CreditService extends IService<CreditLedger> {


    CreditFreezeVO freeze(String runId, Long appId, Long userId, String intensity);


    void settleRun(String runId);


    void refundRun(String runId, AgentCompleteStatusEnum status, Integer filesWritten, Integer milestoneCount);


    void recharge(Long userId, int credits);


    int getBalance(Long userId);


    CreditLedger getByRunId(String runId);


    CreditFreezeVO buildFreezeVO(CreditLedger ledger);
}
