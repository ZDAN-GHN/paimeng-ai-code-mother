package com.zdan.paimengaicodebackend.model.vo;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;
import java.time.LocalDateTime;


@Data
public class RunVO implements Serializable {

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


    private LocalDateTime finishedTime;


    private LocalDateTime createTime;


    private LocalDateTime updateTime;
}
