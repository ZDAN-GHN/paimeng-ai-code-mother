package com.zdan.paimengaicodemother.ai.agent;

import cn.hutool.core.exceptions.ValidateException;
import cn.hutool.jwt.JWT;
import cn.hutool.jwt.JWTUtil;
import cn.hutool.jwt.JWTValidator;
import com.zdan.paimengaicodemother.exception.BusinessException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Date;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Agent JWT 签发服务测试（纯单元测试，不依赖 Spring 上下文）
 * 验收口径：签发可验签、声明齐全（sub 字符串防精度丢失）、过期可判定、错误密钥拒绝
 *
 * @author LXH
 */
class AgentJwtServiceTest {

    private static final String SECRET = "test-shared-secret";
    private static final byte[] SECRET_BYTES = SECRET.getBytes(StandardCharsets.UTF_8);

    private AgentJwtProperties properties;
    private AgentJwtService agentJwtService;

    @BeforeEach
    void setUp() {
        properties = new AgentJwtProperties();
        properties.setSecret(SECRET);
        agentJwtService = new AgentJwtService(properties);
    }

    /**
     * 同一密钥验签通过且算法为 HS256
     */
    @Test
    void issueTokenVerifiesWithSharedKey() {
        String token = agentJwtService.issueToken(123L);
        assertTrue(JWTUtil.verify(token, SECRET_BYTES));
        assertEquals("HS256", JWT.of(token).getAlgorithm());
    }

    /**
     * 声明齐全：sub 为字符串用户 id，iat/exp 为秒级数字且差值等于有效期
     */
    @Test
    void issueTokenCarriesSubIatExp() {
        properties.setTtlMinutes(10);
        long before = System.currentTimeMillis() / 1000 - 1;
        String token = agentJwtService.issueToken(123L);
        JWT jwt = JWT.of(token);
        assertEquals("123", jwt.getPayload("sub"));
        Number iat = (Number) jwt.getPayload("iat");
        Number exp = (Number) jwt.getPayload("exp");
        assertNotNull(iat);
        assertNotNull(exp);
        assertTrue(iat.longValue() >= before);
        assertEquals(properties.getTtlMinutes() * 60, exp.longValue() - iat.longValue());
    }

    /**
     * 大于 JS 安全整数的用户 id 以字符串传输（防精度丢失）
     */
    @Test
    void issueTokenEncodesLongIdAsString() {
        String token = agentJwtService.issueToken(453132478241230849L);
        assertEquals("453132478241230849", JWT.of(token).getPayload("sub"));
    }

    /**
     * 有效期为 0 的令牌按过期判定
     */
    @Test
    void expiredTokenFailsDateValidation() {
        properties.setTtlMinutes(0);
        String token = agentJwtService.issueToken(123L);
        // 校验时点取签发一秒之后，避免同秒边界抖动
        long nowSeconds = System.currentTimeMillis() / 1000 + 1;
        assertThrows(ValidateException.class,
                () -> JWTValidator.of(token).validateDate(new Date(nowSeconds * 1000)));
    }

    /**
     * 错误密钥验签失败（共享密钥错配时 Agent 侧应拒绝）
     */
    @Test
    void wrongKeyFailsVerification() {
        String token = agentJwtService.issueToken(123L);
        assertFalse(JWTUtil.verify(token, "wrong-secret".getBytes(StandardCharsets.UTF_8)));
    }

    /**
     * 密钥未配置时拒绝签发
     */
    @Test
    void blankSecretRejected() {
        properties.setSecret("");
        assertThrows(BusinessException.class, () -> agentJwtService.issueToken(123L));
    }
}
