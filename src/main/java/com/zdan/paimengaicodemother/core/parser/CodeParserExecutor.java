package com.zdan.paimengaicodemother.core.parser;


import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeansException;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ApplicationContextAware;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.Map;

/**
 * 代码解析执行器
 * 根据代码生成类型执行相应的解析逻辑
 *
 * @author LXH
 */
@Component
@Slf4j
public class CodeParserExecutor implements ApplicationContextAware {

    private final Map<String, ICodeParser> codeParserMap = new HashMap<>();

    /**
     * 执行代码解析
     *
     * @param codeContent     代码内容
     * @param codeGenTypeEnum 代码生成类型
     * @return 解析结果（HtmlCodeResult 或 MultiFileCodeResult）
     */
    public Object executeParser(String codeContent, CodeGenTypeEnum codeGenTypeEnum) {
        ICodeParser codeParser = codeParserMap.get(codeGenTypeEnum.getValue());
        if (null == codeParser) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "不支持的代码生成类型：" + codeGenTypeEnum);
        }
        return codeParser.parseCode(codeContent);
    }

    @Override
    public void setApplicationContext(ApplicationContext applicationContext) throws BeansException {
        Map<String, Object> annotatedBeans = applicationContext.getBeansWithAnnotation(CodeParser.class);
        if (CollUtil.isNotEmpty(annotatedBeans)) {
            for (Map.Entry<String, Object> entry : annotatedBeans.entrySet()) {
                Object bean = entry.getValue();
                Class<?> beanClass = bean.getClass();
                // 根据 class 获取到类的注册消息，这里是获取到注解
                CodeParser annotation = beanClass.getAnnotation(CodeParser.class);
                String parseType = annotation.codeGenTypeEnum().getValue();
                if (bean instanceof ICodeParser) {
                    codeParserMap.put(parseType, (ICodeParser) bean);
                    log.info("parser registration completed: parseType = {}, bean = {} ", parseType, beanClass.getName());
                } else {
                    throw new IllegalArgumentException(
                            StrUtil.format("[{}] is annotated with @CodeParser, but missing implementing ICodeParser", beanClass.getName())
                    );
                }
            }
        }
    }
}
