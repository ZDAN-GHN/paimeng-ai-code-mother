package com.zdan.paimengaicodebackend.model.dto.chathistory;

import com.zdan.paimengaicodebackend.common.PageRequest;
import java.io.Serial;
import java.io.Serializable;
import java.time.LocalDateTime;
import lombok.Data;
import lombok.EqualsAndHashCode;

@EqualsAndHashCode(callSuper = true)
@Data
public class ChatHistoryQueryRequest extends PageRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 5483974888570065973L;

    private Long id;

    private String message;

    private String messageType;

    private Long appId;

    private Long userId;

    private LocalDateTime lastCreateTime;
}
