package com.zdan.paimengaicodebackend.ai.agent;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "ts-agent")
public class AgentProperties {

    private boolean enabled = true;

    private int wireframeDailyLimit = 10;

    private Credit credit = new Credit();

    @Data
    public static class Credit {

        private int basePrice = 100;

        private int htmlMultiplier = 1;
        private int multiFileMultiplier = 2;
        private int vueProjectMultiplier = 3;

        private double fastMultiplier = 0.5;
        private double standardMultiplier = 1;
        private double deepMultiplier = 2;

        private double interruptedAdvancedSettleRatio = 0.7;

        private double interruptedBasicSettleRatio = 0.5;
    }
}
