package com.zdan.paimengaicodemother.model.dto.app;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;

/**
 * 应用部署请求
 *
 * @author LXH
 */
@Data
public class AppDeployRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = -4421186777013014372L;

    /**
     * 应用 id
     */
    private Long appId;
}