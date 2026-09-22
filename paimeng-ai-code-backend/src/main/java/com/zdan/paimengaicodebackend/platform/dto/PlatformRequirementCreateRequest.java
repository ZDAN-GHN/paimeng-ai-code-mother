package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
@Schema(description = "提交不可变 Requirement 请求")
public class PlatformRequirementCreateRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = -5560442894874394589L;

    @Schema(description = "Owner 提交的原始自然语言需求", example = "创建一个展示团队作品的网站")
    private String originalText;
}
