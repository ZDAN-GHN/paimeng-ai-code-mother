package com.zdan.paimengaicodebackend.model.dto.app;

import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
public class AppAdminUpdateRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1961355631738857159L;

    private Long id;

    private String appName;

    private String cover;

    private Integer priority;
}
