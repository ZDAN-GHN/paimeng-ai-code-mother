package com.zdan.paimengaicodebackend.model.dto.app;

import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
public class AppDeployRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = -4421186777013014372L;

    private Long appId;
}
