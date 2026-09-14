package com.zdan.paimengaicodebackend.model.vo;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;


@Data
public class AgentTokenVO implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;


    private String token;


    private String workspacePath;


    private Long expiresAt;
}
