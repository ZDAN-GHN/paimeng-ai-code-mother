package com.zdan.paimengaicodebackend.platform.domain;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import org.springframework.stereotype.Component;

@Component
public class TaskExecutionBaselineCodec {

    private final ObjectMapper objectMapper;

    public TaskExecutionBaselineCodec(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public String serialize(TaskExecutionBaseline baseline) {
        try {
            return objectMapper.writeValueAsString(baseline);
        } catch (JsonProcessingException exception) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "TaskExecutionBaseline 序列化失败");
        }
    }

    public TaskExecutionBaseline deserialize(String serializedBaseline) {
        if (serializedBaseline == null || serializedBaseline.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "TaskExecutionBaseline 不能为空");
        }
        try {
            return objectMapper
                .readerFor(TaskExecutionBaseline.class)
                .with(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .readValue(serializedBaseline);
        } catch (JsonProcessingException | IllegalArgumentException exception) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "TaskExecutionBaseline 不合法");
        }
    }
}
