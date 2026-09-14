package com.zdan.paimengaicodebackend.model.dto.app;

import com.zdan.paimengaicodebackend.common.PageRequest;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;
import lombok.EqualsAndHashCode;

@EqualsAndHashCode(callSuper = true)
@Data
public class AppQueryRequest extends PageRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 2905320629317227611L;

    private Long id;

    private String appName;

    private String cover;

    private String initPrompt;

    private String codeGenType;

    private String deployKey;

    private Integer priority;

    private Long userId;
}
