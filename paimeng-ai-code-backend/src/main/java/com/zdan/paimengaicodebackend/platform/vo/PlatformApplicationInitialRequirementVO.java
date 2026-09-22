package com.zdan.paimengaicodebackend.platform.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import lombok.Data;

@Data
@Schema(description = "首页对话创建 Application 与首条 Requirement 的结果")
public class PlatformApplicationInitialRequirementVO {

    private PlatformApplicationVO application;

    private PlatformRequirementVO requirement;
}
