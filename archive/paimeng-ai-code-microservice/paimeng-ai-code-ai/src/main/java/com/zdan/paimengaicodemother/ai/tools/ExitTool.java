package com.zdan.paimengaicodemother.ai.tools;

import cn.hutool.json.JSONObject;
import dev.langchain4j.agent.tool.Tool;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 退出工具
 * 增强 ai 自主规划任务是否结束，此方式比较适合智能体，
 * 因为智能体的任务结束是程序控制的，当 ai 调用了退出工具，程序就会自动终止任务执行；
 * 而 Langchain4j 的工具调用类似智能体，但只给出了工具调用次数限制，人为很难参与任务的终止，
 * 这种方式下，ai 调用终止工具后，本质是将终止提示词发送给 ai ，
 * 但 ai 不一定“听话”，任务是否终止具备不确定性，但几率不大
 *
 * @author LXH
 */
@Slf4j
@Component
public class ExitTool extends BaseTool {

    /**
     * 退出工具调用
     * 当任务完成或无需继续使用工具时调用此方法
     *
     * @return 退出确认信息
     */
    @Tool("当任务已完成或无需继续调用工具时，使用此工具退出操作，防止循环")
    public String exit() {
        log.info("AI 请求退出工具调用");
        // 将终止提示词作为工具调用结果发送给 ai
        return "不要继续调用工具，可以输出最终结果了";
    }

    @Override
    public String getToolName() {
        return "exit";
    }

    @Override
    public String getDisplayName() {
        return "退出工具调用";
    }

    @Override
    public String generateToolExecutedResult(JSONObject arguments) {
        return "\n\n[执行结束]\n\n";
    }
}