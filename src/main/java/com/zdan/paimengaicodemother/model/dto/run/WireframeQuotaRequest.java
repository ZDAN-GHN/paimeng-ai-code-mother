package com.zdan.paimengaicodemother.model.dto.run;

import lombok.Data;

/**
 * 线框生成配额请求（Issue #7）
 * TS Agent 生成线框前经内部 API 获取每用户每日配额
 *
 * @author LXH
 */
@Data
public class WireframeQuotaRequest {

    /**
     * 用户 id（来自 TS Agent 的 JWT sub）
     */
    private Long userId;
}
