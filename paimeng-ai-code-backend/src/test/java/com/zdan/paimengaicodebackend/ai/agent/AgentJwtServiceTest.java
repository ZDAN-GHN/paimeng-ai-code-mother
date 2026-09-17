package com.zdan.paimengaicodebackend.ai.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import cn.hutool.core.exceptions.ValidateException;
import cn.hutool.jwt.JWT;
import cn.hutool.jwt.JWTUtil;
import cn.hutool.jwt.JWTValidator;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import java.nio.charset.StandardCharsets;
import java.util.Date;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

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
        String token = agentJwtService.issueToken(123L, 456L, "/tmp/code_output/html_456");
        assertTrue(JWTUtil.verify(token, SECRET_BYTES));
        assertEquals("HS256", JWT.of(token).getAlgorithm());
    }

    @Test
    void issueTokenCarriesAuthorizedIdentityIatExp() {
        properties.setTtlMinutes(10);
        long before = System.currentTimeMillis() / 1000 - 1;
        String token = agentJwtService.issueToken(123L, 456L, "/tmp/code_output/html_456");
        JWT jwt = JWT.of(token);
        assertEquals("123", jwt.getPayload("sub"));
        assertEquals("456", jwt.getPayload("appId"));
        assertEquals("/tmp/code_output/html_456", jwt.getPayload("workspacePath"));
        Number iat = (Number) jwt.getPayload("iat");
        Number exp = (Number) jwt.getPayload("exp");
        assertNotNull(iat);
        assertNotNull(exp);
        assertTrue(iat.longValue() >= before);
        assertEquals(properties.getTtlMinutes() * 60, exp.longValue() - iat.longValue());
    }

    @Test
    void issueTokenEncodesLongIdsAsStrings() {
        String token = agentJwtService.issueToken(
            453132478241230849L,
            453132478241230850L,
            "/tmp/code_output/html_453132478241230850"
        );
        assertEquals("453132478241230849", JWT.of(token).getPayload("sub"));
        assertEquals("453132478241230850", JWT.of(token).getPayload("appId"));
    }

    @Test
    void expiredTokenFailsDateValidation() {
        properties.setTtlMinutes(0);
        String token = agentJwtService.issueToken(123L, 456L, "/tmp/code_output/html_456");

        long nowSeconds = System.currentTimeMillis() / 1000 + 1;
        assertThrows(ValidateException.class, () ->
            JWTValidator.of(token).validateDate(new Date(nowSeconds * 1000))
        );
    }

    @Test
    void wrongKeyFailsVerification() {
        String token = agentJwtService.issueToken(123L, 456L, "/tmp/code_output/html_456");
        assertFalse(JWTUtil.verify(token, "wrong-secret".getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void blankSecretRejected() {
        properties.setSecret("");
        assertThrows(
            BusinessException.class,
            () -> agentJwtService.issueToken(123L, 456L, "/tmp/code_output/html_456")
        );
    }
}
