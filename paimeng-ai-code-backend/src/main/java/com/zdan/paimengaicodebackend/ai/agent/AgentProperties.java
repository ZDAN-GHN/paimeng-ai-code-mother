package com.zdan.paimengaicodebackend.ai.agent;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "ts-agent")
public class AgentProperties {

    private boolean enabled = true;

}
