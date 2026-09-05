package com.zdan.paimengaicodemother.service;

import com.mybatisflex.core.service.IService;
import com.zdan.paimengaicodemother.model.dto.run.CreditFreezeRequest;
import com.zdan.paimengaicodemother.model.entity.CreditLedger;
import com.zdan.paimengaicodemother.model.enums.AgentCompleteStatusEnum;
import com.zdan.paimengaicodemother.model.vo.CreditFreezeVO;

/**
 * 积分台账（credit_ledger）服务层（Issue #10，docs/ts_agent/architecture.md §7 扣费协议）
 * 预冻结 → 完成结算 → 中断/失败退款；台账与用户余额同库同事务（@Transactional），runId 幂等。
 *
 * @author LXH
 */
public interface CreditService extends IService<CreditLedger> {

    /**
     * 冻结积分（确认线框进入 codegen 时刻，TS Agent 经内部 API 调用）
     * 按次 + 档位系数计费：冻结额 = 基础价 × 生成类型系数 × 推理强度档位系数；
     * 余额不足 → BusinessException(CREDIT_NOT_ENOUGH)；同 runId 重复冻结幂等返回既有台账（不重复扣款）。
     *
     * @param runId    运行 id（幂等键）
     * @param appId    应用 id（codeGenType 系数来源）
     * @param userId   用户 id（余额归属）
     * @param intensity 推理强度档位（fast/standard/deep）
     * @return 冻结结果（台账 id / 冻结额 / 冻结后余额）
     */
    CreditFreezeVO freeze(String runId, Long appId, Long userId, String intensity);

    /**
     * 完成结算（生成成功，status=success）：台账 FROZEN → SETTLED，全额扣费（不再退款）
     *
     * @param runId 运行 id
     */
    void settleRun(String runId);

    /**
     * 退款（失败 / 用户中断）：failed → 全额退款（FROZEN → REFUNDED）；
     * aborted → 首个文件落盘前（filesWritten ≤ 0）全额退款，已写文件按里程碑折算部分退款
     * （FROZEN → PARTIAL_REFUNDED）。退款额加回用户余额。
     *
     * @param runId         运行 id
     * @param status        终态原因（FAILED / ABORTED）
     * @param filesWritten  中断时已落盘文件数（aborted 折算依据；首文件落盘前 = 全额退款）
     * @param milestoneCount 中断时已过里程碑数（部分退款结算比例依据，可为 null）
     */
    void refundRun(String runId, AgentCompleteStatusEnum status, Integer filesWritten, Integer milestoneCount);

    /**
     * 管理员手动充值（架构 §7 MVP 后台充值）：为用户积分余额增加指定数额
     *
     * @param userId  目标用户 id
     * @param credits 充值积分数（正数）
     * @return 充值成功
     */
    boolean recharge(Long userId, int credits);

    /**
     * 查询用户当前积分余额
     *
     * @param userId 用户 id
     * @return 余额（未设置按 0）
     */
    int getBalance(Long userId);

    /**
     * 按 runId 查询台账（幂等判断 / 对账用）
     *
     * @param runId 运行 id
     * @return 台账，无则返回 null
     */
    CreditLedger getByRunId(String runId);
}
