package com.zdan.paimengaicodebackend.model.dto.run;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;
import java.time.LocalDateTime;


@Data
public class RunUpdateRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;


    private String phase;


    private String context;


    private String milestones;


    private String tokenUsage;


    private String creditLedgerRef;


    private LocalDateTime finishedTime;
}
