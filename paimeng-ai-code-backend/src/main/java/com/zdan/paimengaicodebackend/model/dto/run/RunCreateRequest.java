package com.zdan.paimengaicodebackend.model.dto.run;

import java.io.Serial;
import java.io.Serializable;
import java.time.LocalDateTime;
import lombok.Data;

@Data
public class RunCreateRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    private String runId;

    private Long appId;

    private Long userId;

    private String phase;

    private String context;

    private String milestones;

    private String tokenUsage;

    private String creditLedgerRef;

    private LocalDateTime startedTime;
}
