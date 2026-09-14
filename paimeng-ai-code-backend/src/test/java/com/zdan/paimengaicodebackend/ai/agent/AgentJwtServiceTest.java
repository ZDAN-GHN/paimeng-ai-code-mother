package com.zdan.paimengaicodebackend.ai.agent;

import cn.hutool.core.exceptions.ValidateException;
import cn.hutool.jwt.JWT;
import cn.hutool.jwt.JWTUtil;
import cn.hutool.jwt.JWTValidator;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Date;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;


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


    @Test
    void issueTokenVerifiesWithSharedKey() {
        String token = agentJwtService.issueToken(123L);
        assertTrue(JWTUtil.verify(token, SECRET_BYTES));
        assertEquals("HS256", JWT.of(token).getAlgorithm());
    }


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


    @Test
    void issueTokenEncodesLongIdAsString() {
        String token = agentJwtService.issueToken(453132478241230849L);
        assertEquals("453132478241230849", JWT.of(token).getPayload("sub"));
    }


    @Test
    void expiredTokenFailsDateValidation() {
        properties.setTtlMinutes(0);
        String token = agentJwtService.issueToken(123L);

        long nowSeconds = System.currentTimeMillis() / 1000 + 1;
        assertThrows(ValidateException.class,
                () -> JWTValidator.of(token).validateDate(new Date(nowSeconds * 1000)));
    }


    @Test
    void wrongKeyFailsVerification() {
        String token = agentJwtService.issueToken(123L);
        assertFalse(JWTUtil.verify(token, "wrong-secret".getBytes(StandardCharsets.UTF_8)));
    }


    @Test
    void blankSecretRejected() {
        properties.setSecret("");
        assertThrows(BusinessException.class, () -> agentJwtService.issueToken(123L));
    }
}
