package com.zdan.paimengaicodebackend.service;

import com.mybatisflex.core.service.IService;
import com.zdan.paimengaicodebackend.model.dto.run.AgentCompleteRequest;
import com.zdan.paimengaicodebackend.model.dto.run.CreditFreezeRequest;
import com.zdan.paimengaicodebackend.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodebackend.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodebackend.model.entity.GenerationRun;
import com.zdan.paimengaicodebackend.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodebackend.model.vo.RunVO;

/**
 * 生成运行（generation_run）服务层
 * run 状态经 Java 内部 API 由 TS Agent 读写（架构 §3.2，TS Agent 不直连 MySQL）。
 *
 * @author LXH
 */
public interface GenerationRunService extends IService<GenerationRun> {

    /**
     * 创建 run（同 runId 幂等返回既有 run；同 app 已有非终态 run 时拒绝并抛 ConcurrentRunException）
     *
     * @param request 创建请求
     * @return 创建成功后的 run
     */
    RunVO createRun(RunCreateRequest request);

    /**
     * 按 runId 更新 run（phase/上下文/里程碑/计量；幂等：无字段变化时不落库）
     *
     * @param runId   运行 id
     * @param request 更新请求
     * @return 更新后的 run
     */
    RunVO updateRun(String runId, RunUpdateRequest request);

    /**
     * 按 runId 查询 run（断点续传：同 app 最新非终态 run 查询的补充入口）
     *
     * @param runId 运行 id
     * @return run，不存在返回 null
     */
    RunVO getByRunId(String runId);

    /**
     * 查询同 app 最新非终态 run（断点续传的查询基础；终态：done/failed/aborted）
     *
     * @param appId  应用 id
     * @param userId 用户 id（可空，为空不过滤）
     * @return 最新非终态 run，无则返回 null
     */
    RunVO getLatestNonTerminalRun(Long appId, Long userId);

    /**
     * 处理 Agent 完成回调（Issue #6 + #10）：写对话历史 + 积分结算/退款 + 构建
     * success → 结算（台账 SETTLED）+ 构建；failed → 全额退款（REFUNDED）+ 错误历史；
     * aborted → 按里程碑折算退款（PARTIAL_REFUNDED/REFUNDED）+ 历史带 [用户中断] 标记；
     * 同时把 run 推进到对应终态（done/failed/aborted），保证「run 终态与台账状态一致」。
     * 幂等：同 runId 只处理一次，重复回调直接忽略（不重复写历史/构建/记账）。
     *
     * @param runId   运行 id（幂等键）
     * @param request 完成回调请求
     */
    void completeRun(String runId, AgentCompleteRequest request);

    /**
     * 冻结积分（Issue #10）：TS Agent 在「确认线框进入 codegen」时刻调用；
     * appId/userId 从 run 读取，codeGenType 从 app 读取，intensity 由请求透传。
     * 冻结额 = 基础价 × 生成类型系数 × 强度档位系数；余额不足 → CREDIT_NOT_ENOUGH；
     * 同 runId 幂等（重复冻结返回既有台账）；成功后把 creditLedgerRef 写回 run。
     *
     * @param runId   运行 id（幂等键）
     * @param request 冻结请求（intensity）
     * @return 冻结结果
     */
    CreditFreezeVO freezeCredit(String runId, CreditFreezeRequest request);

    /**
     * 获取线框生成每日配额（Issue #7）：线框免费 + 每用户每日独立限频（复用 RateLimit 同机制，
     * Redisson 令牌桶键控 userId；与积分体系无关）。超出 → BusinessException(TOO_MANY_REQUEST)
     *
     * @param userId 用户 id
     * @return 配额获取成功
     */
    boolean acquireWireframeDailyQuota(Long userId);
}
