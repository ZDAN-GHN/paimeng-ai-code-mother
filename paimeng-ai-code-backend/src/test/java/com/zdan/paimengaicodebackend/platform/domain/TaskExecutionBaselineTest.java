package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class TaskExecutionBaselineTest {

    private final TaskExecutionBaselineCodec codec = new TaskExecutionBaselineCodec(new ObjectMapper());
    private final PlatformTaskMapper taskMapper = mock(PlatformTaskMapper.class);
    private final TaskExecutionBaselineFreezer freezer = new TaskExecutionBaselineFreezer(
        codec,
        taskMapper
    );

    @Test
    void parsesTheVersionedInitialApplicationFixture() throws Exception {
        try (InputStream stream = getClass().getResourceAsStream(
            "/contracts/task-execution-baseline/v1-initial-application.json"
        )) {
            String fixture = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            TaskExecutionBaseline baseline = codec.deserialize(fixture);

            assertEquals(TaskExecutionBaseline.CURRENT_SCHEMA_VERSION, baseline.schemaVersion());
            assertEquals("Create an appointment intake workflow", baseline.requestedOutcome());
        }
    }

    @Test
    void rejectsUnknownSchemaVersionsAndFields() {
        assertThrows(BusinessException.class, () -> codec.deserialize(
            "{\"schemaVersion\":2,\"requestedOutcome\":\"x\",\"acceptanceTarget\":\"y\"}"
        ));
        assertThrows(BusinessException.class, () -> codec.deserialize(
            "{\"schemaVersion\":1,\"requestedOutcome\":\"x\",\"acceptanceTarget\":\"y\",\"unknown\":true}"
        ));
    }

    @Test
    void freezesBaselineExactlyOnceAndPersistsIt() {
        PlatformTask task = new PlatformTask();
        task.setId(1L);
        TaskExecutionBaseline baseline = new TaskExecutionBaseline(
            1,
            null,
            null,
            "Create an appointment intake workflow",
            "An owner can submit an appointment request and view its status"
        );
        when(taskMapper.updateByQuery(any(PlatformTask.class), eq(true), any())).thenReturn(1);

        freezer.freeze(task, baseline);

        assertEquals(1, task.getBaselineSchemaVersion());
        assertEquals(baseline.requestedOutcome(), task.getRequestedOutcome());
        verify(taskMapper, times(1)).updateByQuery(any(PlatformTask.class), eq(true), any());
        assertThrows(BusinessException.class, () -> freezer.freeze(task, baseline));
    }

    @Test
    void rejectsBaselineWhenPersistenceFails() {
        PlatformTask task = new PlatformTask();
        task.setId(1L);
        when(taskMapper.updateByQuery(any(PlatformTask.class), eq(true), any())).thenReturn(0);

        assertThrows(BusinessException.class, () -> freezer.freeze(
            task,
            new TaskExecutionBaseline(1, null, null, "outcome", "acceptance")
        ));
    }
}
