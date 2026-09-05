package com.zdan.paimengaicodemother.ai.agent;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Agent 客户端配置（泛化自 python-agent.*，Issue #6）
 * Java → Agent 主通道（Python Agent / TS Agent 通用）与回调终端信号共用的配置段；
 * 旧键 python-agent.* 作为别名保留（expand-contract，见 AgentLegacyAliasPostProcessor）。
 *
 * @author LXH
 */
@Data
@Component
@ConfigurationProperties(prefix = "agent")
public class AgentProperties {

    /**
     * 是否启用 Agent 链路（false 走旧 Java AI 实现，回退链路行为不变）
     */
    private boolean enabled = false;

    /**
     * Agent 服务地址
     */
    private String baseUrl = "http://localhost:8090";

    /**
     * 内部调用令牌（与 Agent 侧配置一致）
     */
    private String token;

    /**
     * 主通道连接超时，毫秒
     */
    private long connectTimeoutMs = 3000;

    /**
     * 主通道读超时，毫秒（期间既无事件也无回调则判定失败）
     */
    private long readTimeoutMs = 300000;

    /**
     * 回调等待超时，毫秒（主通道结束后等待完成回调的最长时间）
     */
    private long callbackTimeoutMs = 60000;

    /**
     * 线框生成每用户每日限频（Issue #7，免费 + 独立限频；滚动 24 小时窗口）
     */
    private int wireframeDailyLimit = 10;

    /**
     * 积分计费配置（Issue #10，架构 §7 按次 + 档位系数）
     */
    private Credit credit = new Credit();

    /**
     * 积分计费参数
     *
     * @author LXH
     */
    @Data
    public static class Credit {

        /**
         * 单次生成基础价（积分；实际冻结 = 基础价 × 生成类型系数 × 推理强度档位系数）
         */
        private int basePrice = 100;

        /**
         * 生成类型系数：html/multi_file/vue_project 分别按 1/2/3 计（MVP 定价档位，可调）
         */
        private int htmlMultiplier = 1;
        private int multiFileMultiplier = 2;
        private int vueProjectMultiplier = 3;

        /**
         * 推理强度档位系数（与 TS Agent INTENSITY_TIERS.priceMultiplier 对齐：fast/standard = 1，deep = 2）
         */
        private int fastMultiplier = 1;
        private int standardMultiplier = 1;
        private int deepMultiplier = 2;

        /**
         * 中断折算：已写文件且进入 review（里程碑 ≥ 3）时按此比例结算（结算额 = 冻结额 × 比例）
         */
        private double interruptedAdvancedSettleRatio = 0.7;

        /**
         * 中断折算：已写文件但未到 review 时按此比例结算
         */
        private double interruptedBasicSettleRatio = 0.5;
    }
}
