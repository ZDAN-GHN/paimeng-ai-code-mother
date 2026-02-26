package com.zdan.paimengaicodemother.langgraph4j.node;

import com.zdan.paimengaicodemother.ai.codegen.route.AiCodeGenTypeRoutingService;
import com.zdan.paimengaicodemother.langgraph4j.state.WorkflowContext;
import com.zdan.paimengaicodemother.model.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.utils.SpringContextUtil;
import lombok.extern.slf4j.Slf4j;
import org.bsc.langgraph4j.action.AsyncNodeAction;
import org.bsc.langgraph4j.prebuilt.MessagesState;

/**
 * 智能路由节点
 * 根据用户提示词，选择合适的执行策略
 *
 * @author LXH
 */
@Slf4j
public class RouterNode {

    public static AsyncNodeAction<MessagesState<String>> create() {
        return AsyncNodeAction.node_async(state -> {
            WorkflowContext context = WorkflowContext.getContext(state);
            log.info("执行节点: 智能路由");

            CodeGenTypeEnum generationType;
            try {
                // 获取AI路由服务
                AiCodeGenTypeRoutingService routingService = SpringContextUtil.getBean(AiCodeGenTypeRoutingService.class);
                // 根据原始提示词进行智能路由
                generationType = routingService.routeCodeGenType(context.getOriginalPrompt());
                log.info("AI智能路由完成，选择类型: {} ({})", generationType.getValue(), generationType.getText());
            } catch (Exception e) {
                log.error("AI智能路由失败，使用默认HTML类型: {}", e.getMessage());
                generationType = CodeGenTypeEnum.HTML;
            }

            // 更新状态
            context.setCurrentStep("智能路由");
            context.setGenerationType(generationType);
            return WorkflowContext.saveContext(context);
        });
    }
}