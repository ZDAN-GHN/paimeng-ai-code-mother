package com.zdan.paimengaicodemother.ai.agent;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * TS Agent 链路配置（原 Agent 中转客户端配置，中转字段已随 T21 删除）
 * ts-agent.enabled 灰度开关门禁 Agent JWT 签发（false 时前端得到明确报错），其余为直连链路运行参数
 *
 * @author LXH
 */
@Data
@Component
@ConfigurationProperties(prefix = "ts-agent")
public class AgentProperties {

    /**
     * 是否启用 TS Agent 新链路（false 时签发端点拒绝下发 JWT；旧 Java AI 链路删除后，回退手段为 git 回滚而非开关）
     */
    private boolean enabled = true;

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
         * 推理强度档位系数（与 TS Agent INTENSITY_TIERS.priceMultiplier 对齐：fast = 0.5，standard = 1，deep = 2）
         */
        private double fastMultiplier = 0.5;
        private double standardMultiplier = 1;
        private double deepMultiplier = 2;

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
