package com.zdan.paimengaicodebackend.model.dto.app;

import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
public class AppAddRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 2938692331213993829L;

    private String initPrompt;
}
