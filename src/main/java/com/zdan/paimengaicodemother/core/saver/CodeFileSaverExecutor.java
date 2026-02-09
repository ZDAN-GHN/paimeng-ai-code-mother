package com.zdan.paimengaicodemother.core.saver;

import cn.hutool.core.collection.CollUtil;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.model.enums.CodeGenTypeEnum;
import org.springframework.beans.BeansException;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ApplicationContextAware;
import org.springframework.stereotype.Component;

import java.io.File;
import java.util.HashMap;
import java.util.Map;

/**
 * 代码文件保存执行器
 * 根据代码生成类型执行相应的保存逻辑
 *
 * @author LXH
 */
@Component
public class CodeFileSaverExecutor implements ApplicationContextAware {

    private final Map<String, BaseCodeFileSaver> codeFileSaverMap = new HashMap<>();

    /**
     * 执行代码保存
     *
     * @param codeResult  代码结果对象
     * @param codeGenTypeEnum 代码生成类型
     * @return 保存的目录
     */
    public File executeSaver(Object codeResult, CodeGenTypeEnum codeGenTypeEnum) {
        BaseCodeFileSaver codeFileSaver = this.codeFileSaverMap.get(codeGenTypeEnum.getValue());
        if (null == codeFileSaver) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "不支持的代码生成类型：" + codeGenTypeEnum);
        }
        return codeFileSaver.saveCode(codeResult);
    }

    @Override
    public void setApplicationContext(ApplicationContext applicationContext) throws BeansException {
        Map<String, Object> annotatedBeans = applicationContext.getBeansWithAnnotation(CodeFileSaver.class);
        if (CollUtil.isNotEmpty(annotatedBeans)) {
            for (Map.Entry<String, Object> entry : annotatedBeans.entrySet()) {
                Object bean = entry.getValue();
                Class<?> beanClass = bean.getClass();
                // 根据 class 获取到类的注册消息，这里是获取到注解
                CodeFileSaver annotation = beanClass.getAnnotation(CodeFileSaver.class);
                String parseType = annotation.codeGenTypeEnum().getValue();
                if (bean instanceof BaseCodeFileSaver) {
                    codeFileSaverMap.put(parseType, (BaseCodeFileSaver) bean);
                    System.out.println("策略注册成功：parseType = " + parseType + "，bean = " + beanClass.getName());
                } else {
                    throw new IllegalArgumentException(
                            "类 " + beanClass.getName() + " 标注了 @CodeParser，但未继承 BaseCodeFileSaver 抽象类");
                }
            }
        }
    }
}
