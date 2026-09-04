package com.zdan.paimengaicodemother.service;

import com.mybatisflex.core.service.IService;
import com.zdan.paimengaicodemother.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodemother.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodemother.model.entity.GenerationRun;
import com.zdan.paimengaicodemother.model.vo.RunVO;

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
}
