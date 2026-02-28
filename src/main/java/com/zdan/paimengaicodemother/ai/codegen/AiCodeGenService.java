package com.zdan.paimengaicodemother.ai.codegen;

import com.zdan.paimengaicodemother.ai.enums.AiModeEnum;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import java.lang.annotation.*;

/**
 * AI 代码应用生成服务注解
 *
 * @author LXH
 */
@Target({ElementType.TYPE}) // 仅作用于类
@Retention(RetentionPolicy.RUNTIME) // 运行时保留，可通过反射获取
@Documented // 标记注解会被包含在 JavaDoc 文档中
public @interface AiCodeGenService {

    CodeGenTypeEnum codeGenTypeEnum();

    AiModeEnum aiMode() default AiModeEnum.CHAT;
}
