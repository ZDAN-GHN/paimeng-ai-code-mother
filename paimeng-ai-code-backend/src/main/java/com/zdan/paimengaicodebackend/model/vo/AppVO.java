package com.zdan.paimengaicodebackend.model.vo;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;
import java.time.LocalDateTime;


@Data
public class AppVO implements Serializable {

    @Serial
    private static final long serialVersionUID = 6961156037867371771L;


    private Long id;


    private String appName;


    private String cover;


    private String initPrompt;


    private String codeGenType;


    private String deployKey;


    private LocalDateTime deployedTime;


    private Integer priority;


    private Long userId;


    private LocalDateTime createTime;


    private LocalDateTime updateTime;


    private UserVO user;
}