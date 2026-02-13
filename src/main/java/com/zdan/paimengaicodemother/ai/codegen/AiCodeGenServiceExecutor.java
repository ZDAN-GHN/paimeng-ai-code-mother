package com.zdan.paimengaicodemother.ai.codegen;

import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.model.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.utils.ClazzScanner;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * Ai 代码生成服务执行器
 *
 * @author LXH
 */
@Slf4j
@Component
public class AiCodeGenServiceExecutor {

    // 保存策略对应的 class 对象
    private final Map<String, Class<? extends IAiCodeGenService>> aiCodeGenServiceClazzMap;

    {
        this.aiCodeGenServiceClazzMap = new HashMap<>();
    }

    private final AiCodeGenServiceFactory aiCodeGenServiceFactory;

    public AiCodeGenServiceExecutor(AiCodeGenServiceFactory aiCodeGenServiceFactory) {
        this.aiCodeGenServiceFactory = aiCodeGenServiceFactory;
    }

    /**
     * 实例化 bean 后加载策略 class（后续使用工厂为每个应用创建实例）
     */
    @PostConstruct
    private void afterConstruct() {
        Set<Class<? extends IAiCodeGenService>> clazzSet = ClazzScanner.scanInterfaces(AiCodeGenService.class.getPackageName(),
                AiCodeGenService.class,
                IAiCodeGenService.class);
        for (Class<? extends IAiCodeGenService> clazz : clazzSet) {
            String domainType = clazz.getAnnotation(AiCodeGenService.class).codeGenTypeEnum().getValue();
            aiCodeGenServiceClazzMap.put(domainType, clazz);
            log.info("aiCodeGenService registration completed, domainType : {}, serviceClass : {}", domainType, clazz);
        }
    }

    /**
     * 执行代码生成
     *
     * @param userMessage     用户 prompt
     * @param codeGenTypeEnum 生成代码类型枚举
     * @param appId
     */
    public <T> T executeCodeGen(String userMessage, CodeGenTypeEnum codeGenTypeEnum, Long appId) {
        IAiCodeGenService aiCodeGenService = getAiCodeGenService(codeGenTypeEnum, appId);
        return aiCodeGenService.generateCode(userMessage);
    }

    /**
     * 执行代码生成（流式）
     *
     * @param userMessage     用户 prompt
     * @param codeGenTypeEnum 生成代码类型枚举
     * @param appId
     */
    public <T> T executeCodeGenStream(String userMessage, CodeGenTypeEnum codeGenTypeEnum, Long appId) {
        IAiCodeGenService aiCodeGenService = getAiCodeGenService(codeGenTypeEnum, appId);
        return aiCodeGenService.generateCodeStream(appId, userMessage);
    }

    /**
     * 获取 ai 代码生成服务实例
     *
     * @param codeGenTypeEnum 生成代码类型枚举
     */
    private IAiCodeGenService getAiCodeGenService(CodeGenTypeEnum codeGenTypeEnum, Long appId) {
        if (codeGenTypeEnum == null) {
            ThrowUtils.throwForParam("代码生成类型不能为空");
        }
        Class<? extends IAiCodeGenService> aiCodeGenServiceClazz = aiCodeGenServiceClazzMap.get(codeGenTypeEnum.getValue());
        if (aiCodeGenServiceClazz == null) {
            log.error("failed to generate code, unsupported code generation type : {}", codeGenTypeEnum);
            ThrowUtils.throwForParam("不支持的代码生成类型");
        }
        return aiCodeGenServiceFactory.getAiCodeGenService(aiCodeGenServiceClazz, appId);
    }
}
