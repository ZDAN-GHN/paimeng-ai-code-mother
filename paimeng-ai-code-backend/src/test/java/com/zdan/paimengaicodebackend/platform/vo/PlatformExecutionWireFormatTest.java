package com.zdan.paimengaicodebackend.platform.vo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodebackend.platform.domain.TaskExecutionBaseline;
import com.zdan.paimengaicodebackend.platform.domain.TaskExecutionBaselineCodec;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * 受控执行 VO 的<strong>线上字节格式</strong>（Issue #77 / T-05）。
 *
 * <p>存在理由：{@code JsonConfig} 注册了进程级 {@code Long}/{@code long} →
 * {@code ToStringSerializer}，因此「数字字段在 JSON 里是数字」这个直觉在本项目<strong>不成立</strong>。
 * 而 {@code int} 与 {@code double} 不在该模块覆盖内，仍是数字——线上格式是混排的。
 *
 * <p>{@code MockMvcBuilders.standaloneSetup()} 不加载 Spring 上下文，用的是默认 ObjectMapper，
 * 观察不到这条规则；所以控制器测试<strong>无法</strong>替代本类。TS Runtime 的 zod 契约必须
 * 按这里钉死的形状编写，否则会拒收合法载荷。
 *
 * <p>本类是跨服务契约的单一事实来源：改动这些字段的 Java 类型，本类会失败，
 * 提示同步修改 {@code paimeng-ai-code-agent/src/protocol/} 下的 zod schema。
 */
@SpringBootTest
class PlatformExecutionWireFormatTest {

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void frozenBaselineUsesDecimalStringForNonNullProfileVersion() throws Exception {
        TaskExecutionBaseline baseline = new TaskExecutionBaseline(
            1, 9007199254740993L, null, "Build app", "Works"
        );
        String serialized = new TaskExecutionBaselineCodec(objectMapper).serialize(baseline);
        JsonNode json = objectMapper.readTree(serialized);

        assertEquals(1, json.get("schemaVersion").asInt());
        assertTrue(json.get("baseProfileVersion").isTextual());
        assertEquals("9007199254740993", json.get("baseProfileVersion").asText());
    }

    @Test
    void longFieldsSerializeAsDecimalStringsAndIntFieldsStayNumbers() throws Exception {
        JsonNode json = objectMapper.valueToTree(capabilities());

        // long → 字符串（JsonConfig 的全局规则）
        assertTrue(json.get("memoryLimitMb").isTextual(), "memoryLimitMb 应为字符串");
        assertEquals("4096", json.get("memoryLimitMb").asText());
        assertTrue(json.get("pidsLimit").isTextual(), "pidsLimit 应为字符串");
        assertTrue(json.get("workspaceTmpfsSizeMb").isTextual(), "workspaceTmpfsSizeMb 应为字符串");
        assertTrue(json.get("tmpfsSizeMb").isTextual(), "tmpfsSizeMb 应为字符串");
        assertTrue(json.get("leaseTtlSeconds").isTextual(), "leaseTtlSeconds 应为字符串");
        assertTrue(json.get("leaseRenewIntervalSeconds").isTextual(), "leaseRenewIntervalSeconds 应为字符串");

        // int 不在 JsonConfig 覆盖内 → 仍是数字
        assertTrue(json.get("leaseMaxRenewCount").isNumber(), "leaseMaxRenewCount 应为数字");
        assertEquals(3, json.get("leaseMaxRenewCount").asInt());
        assertTrue(json.get("defaultCommandTimeoutSeconds").isNumber(), "defaultCommandTimeoutSeconds 应为数字");
        assertTrue(json.get("maxCommandTimeoutSeconds").isNumber(), "maxCommandTimeoutSeconds 应为数字");

        // double 不在覆盖内 → 仍是数字
        assertTrue(json.get("cpuLimit").isNumber(), "cpuLimit 应为数字");

        // boolean 与 String 不受影响
        assertTrue(json.get("networkAccessAvailable").isBoolean());
        assertTrue(json.get("readonlyRootFilesystem").isBoolean());
        assertTrue(json.get("workspacePersistent").isBoolean());
        assertTrue(json.get("schemaVersion").isTextual(), "schemaVersion 是 String 字面量 \"1\"");
        assertEquals("1", json.get("schemaVersion").asText());
        assertTrue(json.get("writablePaths").isArray());
    }

    @Test
    void leaseFenceTokenIsTransmittedAsStringNotNumber() throws Exception {
        JsonNode json = objectMapper.valueToTree(lease());

        // fenceToken 声明为 long，因此同样被全局规则转成字符串。
        // 持有者每次写操作须原样回传，Runtime 侧解析必须按字符串处理。
        assertTrue(json.get("fenceToken").isTextual(), "fenceToken 应为字符串");
        assertEquals("3", json.get("fenceToken").asText());
        // renewCount 是 int → 数字
        assertTrue(json.get("renewCount").isNumber(), "renewCount 应为数字");
        // 显式声明为 String 的 ID 字段结果一致
        assertTrue(json.get("applicationId").isTextual());
        assertTrue(json.get("taskId").isTextual());
    }

    @Test
    void commandResultDurationIsStringAndExitCodeIsNumber() throws Exception {
        PlatformRunCommandResultVO result = new PlatformRunCommandResultVO();
        result.setRunId("run-7001");
        result.setExitCode(0);
        result.setStdout("ok\n");
        result.setStderr("");
        result.setDurationMs(184L);

        JsonNode json = objectMapper.valueToTree(result);

        assertTrue(json.get("durationMs").isTextual(), "durationMs 应为字符串");
        assertEquals("184", json.get("durationMs").asText());
        // 退出码是命令的正常结果，必须保持数字以便 Runtime 直接比较
        assertTrue(json.get("exitCode").isNumber(), "exitCode 应为数字");
    }

    /**
     * {@code LocalDateTime} 无时区偏移。zod 的 {@code z.iso.datetime()} 默认要求偏移，
     * 因此 Runtime 侧必须用 {@code z.iso.datetime({ local: true })} 或等价形状，
     * 否则会拒收合法载荷。
     */
    @Test
    void leaseTimestampsAreLocalIsoWithoutZoneOffset() throws Exception {
        JsonNode json = objectMapper.valueToTree(lease());

        String grantedAt = json.get("grantedAt").asText();
        assertTrue(json.get("grantedAt").isTextual(), "grantedAt 应为 ISO 字符串而非时间戳数组");
        assertEquals("2026-01-01T00:00:00", grantedAt);
        assertTrue(
            !grantedAt.endsWith("Z") && !grantedAt.contains("+"),
            "LocalDateTime 不带时区偏移，Runtime 的 zod 契约需按 local 处理：" + grantedAt
        );
    }

    /**
     * 落盘 fixture 与实际序列化结果保持一致。
     *
     * <p>TS 侧的 zod 契约测试读的是同一份 fixture（沿用 {@code task-execution-baseline} 的约定：
     * fixture 由 Java 拥有，两侧各读同一份字节）。若没有本断言，改动 VO 后 fixture 会静默过期，
     * 于是 TS 测试对着<strong>历史契约</strong>通过，线上却拒收真实载荷——两侧同时"绿"但不兼容。
     *
     * <p>比较 {@code JsonNode} 而非字符串：缩进与键序是排版，不是契约；字段名、类型、取值才是。
     */
    @Test
    void serializedCapabilitiesMatchTheSharedContractFixture() throws Exception {
        try (InputStream stream = getClass().getResourceAsStream(
            "/contracts/platform-execution-capabilities/v1-sandbox-defaults.json"
        )) {
            assertTrue(stream != null, "契约 fixture 缺失");
            JsonNode fixture = objectMapper.readTree(
                new String(stream.readAllBytes(), StandardCharsets.UTF_8)
            );

            assertEquals(
                fixture,
                objectMapper.valueToTree(capabilities()),
                "fixture 与实际序列化结果不一致：同步更新 fixture 与 "
                    + "paimeng-ai-code-agent/src/protocol/executionCapabilities.ts"
            );
        }
    }

    private PlatformExecutionCapabilitiesVO capabilities() {
        PlatformExecutionCapabilitiesVO capabilities = new PlatformExecutionCapabilitiesVO();
        capabilities.setWorkspacePath("/workspace");
        capabilities.setWorkspacePersistent(false);
        capabilities.setWritablePaths(List.of("/workspace", "/tmp"));
        capabilities.setNetworkAccessAvailable(false);
        capabilities.setReadonlyRootFilesystem(true);
        capabilities.setMemoryLimitMb(4096L);
        capabilities.setCpuLimit(2.0);
        capabilities.setPidsLimit(256L);
        capabilities.setWorkspaceTmpfsSizeMb(2048L);
        capabilities.setTmpfsSizeMb(512L);
        capabilities.setLeaseTtlSeconds(60L);
        capabilities.setLeaseRenewIntervalSeconds(20L);
        capabilities.setLeaseMaxRenewCount(3);
        capabilities.setDefaultCommandTimeoutSeconds(300);
        capabilities.setMaxCommandTimeoutSeconds(900);
        return capabilities;
    }

    private PlatformRunLeaseVO lease() {
        PlatformRunLeaseVO lease = new PlatformRunLeaseVO();
        lease.setRunId("run-7001");
        lease.setApplicationId("460017668615995392");
        lease.setTaskId("460017668615995393");
        lease.setFenceToken(3L);
        lease.setGrantedAt(LocalDateTime.of(2026, 1, 1, 0, 0));
        lease.setExpiresAt(LocalDateTime.of(2026, 1, 1, 0, 1));
        lease.setRenewCount(0);
        return lease;
    }
}
