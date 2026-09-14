package com.zdan.paimengaicodebackend.model.dto.app;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;


@Data
public class AppUpdateRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = -8710388518932158927L;


    private Long id;


    private String appName;
}