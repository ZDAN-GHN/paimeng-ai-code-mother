package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
@Schema(description = "从首页对话创建 Platform Application 并提交首条 Requirement 请求")
public class PlatformApplicationInitialRequirementRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 8702511868114112192L;

    @Schema(description = "Application 名称", example = "作品展示网站")
    private String name;

    @Schema(description = "Owner 输入的首条原始自然语言需求", example = "创建一个展示团队作品的网站")
    private String originalText;
}
