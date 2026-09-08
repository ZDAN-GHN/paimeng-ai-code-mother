package com.zdan.paimengaicodemother.ai.agent;

import cn.hutool.core.util.StrUtil;
import cn.hutool.jwt.JWT;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.Date;

/**
 * Agent JWT 签发服务
 * 为已登录用户签发浏览器直连 TS Agent 的短时 HS256 令牌；Agent 持共享密钥离线验签，不回查本服务
 *
 * @author LXH
 */
@Service
public class AgentJwtService {

    private final AgentJwtProperties properties;

    public AgentJwtService(AgentJwtProperties properties) {
        this.properties = properties;
    }

    /**
     * 为用户签发短时 JWT
     * 声明：sub=用户 id（字符串，防 JS 侧 Long 精度丢失）、iat=签发时间、exp=过期时间
     *
     * @param userId 用户 id
     * @return 签发的 JWT
     */
    public String issueToken(long userId) {
        if (StrUtil.isBlank(properties.getSecret())) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "Agent JWT 密钥未配置（ts-agent.jwt.secret）");
        }
        // exp 与 iat 从同一时基整秒计算（与 Agent 侧 jose 的 NumericDate 精度对齐）
        long nowSeconds = System.currentTimeMillis() / 1000;
        long expSeconds = nowSeconds + properties.getTtlMinutes() * 60;
        return JWT.create()
                .setKey(properties.getSecret().getBytes(StandardCharsets.UTF_8))
                .setPayload("sub", String.valueOf(userId))
                .setIssuedAt(new Date(nowSeconds * 1000))
                .setExpiresAt(new Date(expSeconds * 1000))
                .sign();
    }
}
