package com.zdan.paimengaicodemother.core.saver;

import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import org.springframework.stereotype.Component;

import java.lang.annotation.*;

/**
 * 标记代码文件保存器所在类
 *
 * @author ZDAN
 */
@Target({ElementType.TYPE}) // 仅作用于类
@Retention(RetentionPolicy.RUNTIME) // 运行时保留，可通过反射获取
@Documented // 标记注解会被包含在 JavaDoc 文档中
@Component // 间接让 Spring 扫描为 Bean（无需额外加 @Service/@Component）
public @interface CodeFileSaver {

    CodeGenTypeEnum codeGenTypeEnum();
}
