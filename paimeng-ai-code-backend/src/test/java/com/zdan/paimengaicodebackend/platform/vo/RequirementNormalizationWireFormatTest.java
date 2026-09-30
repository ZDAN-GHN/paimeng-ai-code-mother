package com.zdan.paimengaicodebackend.platform.vo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformOwnerVisibleStatus;
import com.zdan.paimengaicodebackend.platform.domain.PlatformProgressStage;
import com.zdan.paimengaicodebackend.platform.dto.PlatformNormalizationResultRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRunProgressRequest;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * 归一化工作项的线上格式（Issue #80 / T-08）
 *
 * <p>断言的是 {@code src/test/resources/contracts/requirement-normalization/v1} 下的固定夹具，
 * 而不是内联对象：TS Agent 的测试直接读同一批文件，因此字段名或 null 形态漂移会同时打红两端，
 * 不需要等到联调才发现。标识符必须是十进制字符串——Java 的 long 超过
 * {@code Number.MAX_SAFE_INTEGER}，序列化成 JSON number 会在前端静默取到相邻 id。
 */
class RequirementNormalizationWireFormatTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private String read(String fixture) throws IOException {
        try (InputStream stream = getClass().getResourceAsStream(
            "/contracts/requirement-normalization/v1/" + fixture)) {
            assertTrue(stream != null, "缺少契约夹具 " + fixture);
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void ownerRequestWorkItemKeepsIdentifiersAsDecimalStrings() throws Exception {
        PlatformNormalizationWorkItemVO item = mapper.readValue(
            read("owner-request-work-item.json"), PlatformNormalizationWorkItemVO.class);

        assertEquals("460017668615995392", item.getApplicationId());
        assertEquals("460017668615995393", item.getRequirementId());
        assertEquals("460017668615995394", item.getTaskId());
        assertEquals("1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64", item.getAttemptId());
        assertEquals("OWNER_REQUEST", item.getRequirementKind());
        assertNull(item.getParentRequirementId());
        assertNull(item.getParentRequirementText());

        String serialized = mapper.writeValueAsString(item);
        assertTrue(serialized.contains("\"applicationId\":\"460017668615995392\""), serialized);
    }

    @Test
    void clarificationAnswerCarriesBothTheAnswerAndTheOriginalRequirement() throws Exception {
        PlatformNormalizationWorkItemVO item = mapper.readValue(
            read("clarification-answer-work-item.json"), PlatformNormalizationWorkItemVO.class);

        assertEquals("CLARIFICATION_ANSWER", item.getRequirementKind());
        assertEquals("460017668615995393", item.getParentRequirementId());
        // 没有原文，重新归一化就会为了迁就答复而悄悄改写当初的意图。
        assertEquals("我想要一个预约管理的小程序", item.getParentRequirementText());
    }

    @Test
    void runWorkItemExposesIdentityOnlyAndKeepsTheAttemptAsANumber() throws Exception {
        PlatformRunWorkItemVO item = mapper.readValue(read("run-work-item.json"), PlatformRunWorkItemVO.class);

        assertEquals("run-1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64", item.getRunId());
        assertEquals(1, item.getAttemptNumber());
    }

    @Test
    void theNormalizerResultAcceptsEveryOutcomeTheContractDeclares() throws IOException {
        for (String outcome : new String[] {"READY", "BLOCKED", "FAILED"}) {
            PlatformNormalizationResultRequest request = new PlatformNormalizationResultRequest();
            request.setApplicationId("460017668615995392");
            request.setTaskId("460017668615995394");
            request.setAttemptId("1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64");
            request.setOutcome(outcome);
            request.setRequestId("normalize-1");
            switch (outcome) {
                case "READY" -> {
                    request.setRequestedOutcome("支持预约");
                    request.setAcceptanceTarget("可以提交并查看预约");
                }
                case "BLOCKED" -> request.setBlockingQuestion("客户可以提前几天预约？");
                default -> request.setReasonCode("NORMALIZATION_MODEL_UNAVAILABLE");
            }
            String serialized = mapper.writeValueAsString(request);
            assertTrue(serialized.contains("\"attemptId\""), outcome + ": " + serialized);
        }
    }

    @Test
    void ownerStatusProjectionSerializesAsAClosedValueSet() throws Exception {
        PlatformApplicationStatusVO status = new PlatformApplicationStatusVO();
        status.setApplicationId("460017668615995392");
        status.setStatus(PlatformOwnerVisibleStatus.AWAITING_NORMALIZATION);
        status.setProgressStage(PlatformProgressStage.NORMALIZING);
        status.setAnswerRequired(false);
        status.setArchived(false);

        String serialized = mapper.writeValueAsString(status);
        assertTrue(serialized.contains("\"status\":\"AWAITING_NORMALIZATION\""), serialized);
        assertTrue(serialized.contains("\"progressStage\":\"NORMALIZING\""), serialized);
        // 未设置的可选字段序列化为 null；前端按 answerRequired 决定是否展示，
        // 因此这里断言的是「字段存在但为空」，不是「字段缺席」。
        assertTrue(serialized.contains("\"blockingQuestion\":null"), serialized);
    }

    @Test
    void progressReportCarriesOnlyAStageAndASentence() throws Exception {
        PlatformRunProgressRequest request = new PlatformRunProgressRequest();
        request.setApplicationId("460017668615995392");
        request.setRunId("run-7001");
        request.setStage("EXECUTING");
        request.setNote("正在生成页面与数据表");
        request.setRequestId("progress-1");

        String serialized = mapper.writeValueAsString(request);
        assertTrue(serialized.contains("\"stage\":\"EXECUTING\""), serialized);
        // 契约里没有工具名、命令、容器或 Session 字段，前端也就无从渲染它们。
        for (String forbidden : Stream.of("toolName", "command", "container", "session", "evidenceRef").toList()) {
            assertTrue(!serialized.contains(forbidden), "进度契约泄露了 " + forbidden + ": " + serialized);
        }
    }
}
