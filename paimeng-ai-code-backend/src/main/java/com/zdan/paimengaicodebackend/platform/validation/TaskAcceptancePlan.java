package com.zdan.paimengaicodebackend.platform.validation;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** Bounded, application-relative HTTP assertions; free-form targets never become a PASS. */
public record TaskAcceptancePlan(List<Check> checks) {
    private static final int MAX_BYTES = 16 * 1024;
    private static final Set<String> METHODS = Set.of("GET", "POST", "PUT", "PATCH", "DELETE");
    private static final Set<String> PLAN_FIELDS = Set.of("schemaVersion", "checks");
    private static final Set<String> CHECK_FIELDS = Set.of("method", "path", "requestBody", "expectedStatus", "expectedBody");
    private static final Set<String> BODY_FIELDS = Set.of("pointer", "equals");

    public TaskAcceptancePlan {
        checks = List.copyOf(checks);
    }

    public static ParseResult parse(String text, ObjectMapper mapper) {
        if (text == null || text.isBlank() || text.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            return new ParseResult(null, "INCONCLUSIVE_TARGET");
        }
        try (JsonParser parser = mapper.createParser(text)) {
            parser.enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
            JsonNode root = mapper.readTree(parser);
            if (parser.nextToken() != null || !onlyFields(root, PLAN_FIELDS)
                || !root.path("schemaVersion").isInt() || root.path("schemaVersion").intValue() != 1
                || !root.path("checks").isArray() || root.path("checks").isEmpty()
                || root.path("checks").size() > 16) return new ParseResult(null, "INCONCLUSIVE_TARGET");
            List<Check> checks = new ArrayList<>();
            for (JsonNode item : root.path("checks")) {
                if (!onlyFields(item, CHECK_FIELDS) || !item.path("method").isTextual()
                    || !item.path("path").isTextual() || !METHODS.contains(item.path("method").textValue())
                    || !validPath(item.path("path").textValue())
                    || !item.path("expectedStatus").isInt()
                    || item.path("expectedStatus").intValue() < 200 || item.path("expectedStatus").intValue() > 499) {
                    return new ParseResult(null, "INCONCLUSIVE_TARGET");
                }
                String method = item.path("method").textValue();
                JsonNode requestBody = item.get("requestBody");
                if (requestBody != null && (!requestBody.isObject() || method.equals("GET"))) {
                    return new ParseResult(null, "INCONCLUSIVE_TARGET");
                }
                JsonNode expectedBody = item.get("expectedBody");
                if (expectedBody != null && (!onlyFields(expectedBody, BODY_FIELDS)
                    || !expectedBody.path("pointer").isTextual()
                    || !validPointer(expectedBody.path("pointer").textValue())
                    || !expectedBody.has("equals") || expectedBody.get("equals").isContainerNode())) {
                    return new ParseResult(null, "INCONCLUSIVE_TARGET");
                }
                checks.add(new Check(method, item.path("path").textValue(),
                    requestBody == null ? null : requestBody.deepCopy(),
                    item.path("expectedStatus").intValue(),
                    expectedBody == null ? null : expectedBody.path("pointer").textValue(),
                    expectedBody == null ? null : expectedBody.get("equals").deepCopy()));
            }
            return new ParseResult(new TaskAcceptancePlan(checks), "ACCEPTED");
        } catch (IOException | IllegalArgumentException e) {
            return new ParseResult(null, "INCONCLUSIVE_TARGET");
        }
    }

    private static boolean onlyFields(JsonNode node, Set<String> allowed) {
        if (node == null || !node.isObject()) return false;
        var fields = node.fieldNames();
        while (fields.hasNext()) if (!allowed.contains(fields.next())) return false;
        return true;
    }

    private static boolean validPath(String path) {
        return path.length() > 0 && path.length() <= 256
            && path.matches("/[A-Za-z0-9/_-]*") && !path.contains("//")
            && !path.contains("/../") && !path.endsWith("/..");
    }

    private static boolean validPointer(String pointer) {
        return pointer.length() <= 256 && (pointer.isEmpty() || pointer.startsWith("/"))
            && !pointer.chars().anyMatch(ch -> ch < 32 || ch == 127);
    }

    public record ParseResult(TaskAcceptancePlan plan, String reasonCode) { }

    public record Check(String method, String path, JsonNode requestBody, int expectedStatus,
                        String jsonPointer, JsonNode expectedValue) {
        public boolean matches(int actualStatus, JsonNode actualBody) {
            return actualStatus == expectedStatus && (jsonPointer == null
                || (actualBody != null && !actualBody.at(jsonPointer).isMissingNode()
                    && actualBody.at(jsonPointer).equals(expectedValue)));
        }
    }
}
