package com.zdan.paimengaicodebackend.ai.agent;

import cn.hutool.core.util.StrUtil;
import cn.hutool.jwt.JWT;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.Date;


@Service
public class AgentJwtService {

    private final AgentJwtProperties properties;

    public AgentJwtService(AgentJwtProperties properties) {
        this.properties = properties;
    }


    public String issueToken(long userId) {
        if (StrUtil.isBlank(properties.getSecret())) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "Agent JWT 密钥未配置（ts-agent.jwt.secret）");
        }

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
