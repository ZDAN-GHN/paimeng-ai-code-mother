package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
@Schema(description = "创建 Platform Application 请求")
public class PlatformApplicationCreateRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = -2333656382978407477L;

    @Schema(description = "Application 名称", example = "我的产品")
    private String name;
}
