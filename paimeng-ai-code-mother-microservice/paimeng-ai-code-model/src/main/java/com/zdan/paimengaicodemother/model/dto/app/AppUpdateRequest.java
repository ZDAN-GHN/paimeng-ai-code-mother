package com.zdan.paimengaicodemother.model.dto.app;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;

/**
 * 更新应用请求
 *
 * @author LXH
 */
@Data
public class AppUpdateRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = -8710388518932158927L;

    /**
     * id
     */
    private Long id;

    /**
     * 应用名称
     */
    private String appName;
}