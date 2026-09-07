package com.zdan.paimengaicodemother.langgraph4j.node.concurrent;

import com.zdan.paimengaicodemother.langgraph4j.model.ImageCollectionPlan;
import com.zdan.paimengaicodemother.langgraph4j.model.ImageResource;
import com.zdan.paimengaicodemother.langgraph4j.state.WorkflowContext;
import com.zdan.paimengaicodemother.langgraph4j.tools.WebImageSearchTool;
import com.zdan.paimengaicodemother.utils.SpringContextUtil;
import lombok.extern.slf4j.Slf4j;
import org.bsc.langgraph4j.action.AsyncNodeAction;
import org.bsc.langgraph4j.prebuilt.MessagesState;

import java.util.ArrayList;
import java.util.List;

/**
 * 全网热词图片收集节点
 *
 * @author LXH
 */
@Slf4j
public class WebImageCollectorNode {

    public static AsyncNodeAction<MessagesState<String>> create() {
        return AsyncNodeAction.node_async(state -> {
            WorkflowContext context = WorkflowContext.getContext(state);
            List<ImageResource> webImages = new ArrayList<>();
            try {
                ImageCollectionPlan plan = context.getImageCollectionPlan();
                if (plan != null && plan.getWebImageTasks() != null) {
                    WebImageSearchTool webImageSearchTool = SpringContextUtil.getBean(WebImageSearchTool.class);
                    log.info("开始并发收集全网热词图片，任务数: {}", plan.getWebImageTasks().size());
                    for (ImageCollectionPlan.ImageSearchTask task : plan.getWebImageTasks()) {
                        List<ImageResource> images = webImageSearchTool.searchWebImages(task.query());
                        if (images != null) {
                            webImages.addAll(images);
                        }
                    }
                    log.info("全网热词图片收集完成，共收集到 {} 张图片", webImages.size());
                }
            } catch (Exception e) {
                log.error("全网热词图片收集失败: {}", e.getMessage(), e);
            }
            // 将收集到的图片存储到上下文的中间字段中
            context.setWebImages(webImages);
            context.setCurrentStep("全网热词图片收集");
            return WorkflowContext.saveContext(context);
        });
    }
}
