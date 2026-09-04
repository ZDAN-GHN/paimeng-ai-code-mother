package com.zdan.paimengaicodemother.model.vo;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;

/**
 * Agent 直连令牌视图
 * 浏览器以 fetch-SSE 携带 Authorization 头直连 TS Agent 所需的凭据与工作区路径
 *
 * @author LXH
 */
@Data
public class AgentTokenVO implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    /**
     * 短时 JWT
     */
    private String token;

    /**
     * 应用工作区绝对路径（Java 按 CODE_OUTPUT_ROOT_DIR 计算，Agent 沙箱校验不逃逸）
     */
    private String workspacePath;

    /**
     * 令牌过期时间（毫秒时间戳）
     */
    private Long expiresAt;
}
