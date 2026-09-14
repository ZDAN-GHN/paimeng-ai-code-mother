package com.zdan.paimengaicodebackend.model.dto.run;

import java.io.Serial;
import java.io.Serializable;
import java.util.List;
import lombok.Data;

@Data
public class AgentCompleteRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    private Long appId;

    private Long userId;

    private String status;

    private List<Message> messages;

    private Integer filesWritten;

    private String workspacePath;

    private String errorCode;

    private String errorMessage;

    @Data
    public static class Message implements Serializable {

        @Serial
        private static final long serialVersionUID = 1L;

        private String messageType;

        private String content;
    }
}
