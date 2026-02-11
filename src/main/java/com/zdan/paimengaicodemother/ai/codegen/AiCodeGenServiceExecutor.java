package com.zdan.paimengaicodemother.ai.codegen;

import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
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

    private final Map<String, IAiCodeGenService> aiCodeGenServiceMap;

    {
        this.aiCodeGenServiceMap = new HashMap<>();
    }

    private final AiCodeGenServiceFactory aiCodeGenServiceFactory;

    public AiCodeGenServiceExecutor(AiCodeGenServiceFactory aiCodeGenServiceFactory) {
        this.aiCodeGenServiceFactory = aiCodeGenServiceFactory;
    }

    /**
     * 实例化 bean 后加载策略（使用工厂创建 + 策略注册）
     */
    @PostConstruct
    private void afterConstruct() {
        Set<Class<IAiCodeGenService>> clazzSet = ClazzScanner.scanInterfaces(AiCodeGenService.class.getPackageName(),
                AiCodeGenService.class,
                IAiCodeGenService.class);
        for (Class<IAiCodeGenService> clazz : clazzSet) {
            String domainType = clazz.getAnnotation(AiCodeGenService.class).codeGenTypeEnum().getValue();
            IAiCodeGenService aiCodeGenService = aiCodeGenServiceFactory.createAiCodeGenService(clazz);
            aiCodeGenServiceMap.put(domainType, aiCodeGenService);
            log.info("codeGenService registration completed: domainType = {}, bean = {} ", domainType,
                    aiCodeGenService.getClass().getName());
        }
    }

    /**
     * 执行代码生成
     *
     * @param userMessage     用户 prompt
     * @param codeGenTypeEnum 生成代码类型枚举
     */
    public <T> T executeCodeGen(String userMessage, CodeGenTypeEnum codeGenTypeEnum) {
        IAiCodeGenService aiCodeGenService = getiAiCodeGenService(codeGenTypeEnum);
        return aiCodeGenService.generateCode(userMessage);
    }

    /**
     * 执行代码生成（流式）
     *
     * @param userMessage     用户 prompt
     * @param codeGenTypeEnum 生成代码类型枚举
     */
    public Flux<String> executeCodeGenStream(String userMessage, CodeGenTypeEnum codeGenTypeEnum) {
        IAiCodeGenService aiCodeGenService = getiAiCodeGenService(codeGenTypeEnum);
        return aiCodeGenService.generateCodeStream(userMessage);
    }

    /**
     * 获取 ai 代码生成服务实例
     *
     * @param codeGenTypeEnum 生成代码类型枚举
     */
    private IAiCodeGenService getiAiCodeGenService(CodeGenTypeEnum codeGenTypeEnum) {
        IAiCodeGenService aiCodeGenService = aiCodeGenServiceMap.get(codeGenTypeEnum.getValue());
        if (null == aiCodeGenService) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "不支持代码生成类型");
        }
        return aiCodeGenService;
    }
}
