package com.zdan.paimengaicodebackend.service;

import com.mybatisflex.core.service.IService;
import com.zdan.paimengaicodebackend.model.dto.run.AgentCompleteRequest;
import com.zdan.paimengaicodebackend.model.dto.run.CreditFreezeRequest;
import com.zdan.paimengaicodebackend.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodebackend.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodebackend.model.entity.GenerationRun;
import com.zdan.paimengaicodebackend.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodebackend.model.vo.RunVO;


public interface GenerationRunService extends IService<GenerationRun> {


    RunVO createRun(RunCreateRequest request);


    RunVO updateRun(String runId, RunUpdateRequest request);


    RunVO getByRunId(String runId);


    RunVO getLatestNonTerminalRun(Long appId, Long userId);


    void completeRun(String runId, AgentCompleteRequest request);


    CreditFreezeVO freezeCredit(String runId, CreditFreezeRequest request);


    boolean acquireWireframeDailyQuota(Long userId);
}
