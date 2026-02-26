package com.zdan.paimengaicodemother.langgraph4j.node;

import com.zdan.paimengaicodemother.core.builder.BuilderExecutor;
import com.zdan.paimengaicodemother.langgraph4j.state.WorkflowContext;
import com.zdan.paimengaicodemother.model.enums.CodeGenTypeEnum;
import lombok.extern.slf4j.Slf4j;
import org.bsc.langgraph4j.action.AsyncNodeAction;
import org.bsc.langgraph4j.prebuilt.MessagesState;

import java.io.File;
import java.util.Objects;

/**
 * 项目构建节点
 * 根据选择的项目类型，选择合适的策略进行构建
 *
 * @author LXH
 */
@Slf4j
public class ProjectBuilderNode {

    public static AsyncNodeAction<MessagesState<String>> create() {
        return AsyncNodeAction.node_async(state -> {
            WorkflowContext context = WorkflowContext.getContext(state);
            log.info("执行节点: 项目构建");

            // 获取必要的参数
            String generatedCodeDir = context.getGeneratedCodeDir();
            CodeGenTypeEnum generationType = context.getGenerationType();
            String buildResultDir;
            try {
                File buildResult = BuilderExecutor.doBuild(generationType, generatedCodeDir);
                // 构建成功，返回 dist 目录路径
                buildResultDir = Objects.requireNonNull(buildResult).getAbsolutePath();
                log.info("项目构建成功，项目目录: {}", buildResultDir);
            } catch (Exception e) {
                log.error("项目构建异常: {}", e.getMessage(), e);
                buildResultDir = generatedCodeDir; // 异常时返回原路径
            }
            // 更新状态
            context.setCurrentStep("项目构建");
            context.setBuildResultDir(buildResultDir);
            log.info("项目构建节点完成，最终目录: {}", buildResultDir);
            return WorkflowContext.saveContext(context);
        });
    }
}