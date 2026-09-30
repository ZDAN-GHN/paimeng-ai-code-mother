package com.zdan.paimengaicodebackend.platform.validation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class TaskAcceptancePlanTest {
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void evaluatesExplicitApplicationRelativeHttpAssertion() throws Exception {
        var parsed = TaskAcceptancePlan.parse("""
            {"schemaVersion":1,"checks":[{"method":"POST","path":"/api/items",
            "requestBody":{"title":"synthetic"},"expectedStatus":201,
            "expectedBody":{"pointer":"/title","equals":"synthetic"}}]}
            """, mapper);
        assertEquals("ACCEPTED", parsed.reasonCode());
        var check = parsed.plan().checks().getFirst();
        assertTrue(check.matches(201, mapper.readTree("{\"title\":\"synthetic\"}")));
        assertFalse(check.matches(200, mapper.readTree("{\"title\":\"synthetic\"}")));
        assertFalse(check.matches(201, mapper.readTree("{\"title\":\"wrong\"}")));
        assertFalse(check.matches(201, mapper.readTree("{}")));
    }

    @Test
    void freeTextUnsafePathAndUnknownFieldsNeverYieldExecutablePlan() {
        for (String text : new String[]{"please test the app", "{}", "{\"schemaVersion\":1,\"checks\":[]}",
            "{\"schemaVersion\":1,\"checks\":[{\"method\":\"GET\",\"path\":\"http://example.com\",\"expectedStatus\":200}]}",
            "{\"schemaVersion\":1,\"checks\":[{\"method\":\"GET\",\"path\":\"/api/%2e%2e/secret\",\"expectedStatus\":200}]}",
            "{\"schemaVersion\":1,\"schemaVersion\":1,\"checks\":[{\"method\":\"GET\",\"path\":\"/api/items\",\"expectedStatus\":200}]}",
            "{\"schemaVersion\":1,\"checks\":[{\"method\":\"GET\",\"path\":\"/api/items\",\"expectedStatus\":200,\"extra\":true}]}",
            "{\"schemaVersion\":1,\"checks\":[{\"method\":\"GET\",\"path\":\"/api/items\",\"expectedStatus\":200}]} true"}) {
            var parsed = TaskAcceptancePlan.parse(text, mapper);
            assertNull(parsed.plan(), text);
            assertEquals("INCONCLUSIVE_TARGET", parsed.reasonCode(), text);
        }
    }
}
