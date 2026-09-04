package com.zdan.paimengaicodemother.config;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.MutablePropertySources;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * python-agent.* → agent.* 配置别名（expand-contract 的 expand 阶段，Issue #6）
 * 迁移期旧部署只写 python-agent.* 也能跑：当 agent.* 未显式设置时，把同名旧键复制到新前缀；
 * 两者都设置时新键优先（复制仅在旧键存在、新键缺失时发生）。
 *
 * @author LXH
 */
public class AgentLegacyAliasPostProcessor implements EnvironmentPostProcessor, Ordered {

    /**
     * 旧键 → 新键（spring 宽松绑定的下划线/短横线键名）
     */
    private static final List<String[]> ALIASES = List.of(
            new String[]{"python-agent.enabled", "agent.enabled"},
            new String[]{"python-agent.base-url", "agent.base-url"},
            new String[]{"python-agent.base_url", "agent.base-url"},
            new String[]{"python-agent.token", "agent.token"},
            new String[]{"python-agent.connect-timeout-ms", "agent.connect-timeout-ms"},
            new String[]{"python-agent.connect_timeout_ms", "agent.connect-timeout-ms"},
            new String[]{"python-agent.read-timeout-ms", "agent.read-timeout-ms"},
            new String[]{"python-agent.read_timeout_ms", "agent.read-timeout-ms"},
            new String[]{"python-agent.callback-timeout-ms", "agent.callback-timeout-ms"},
            new String[]{"python-agent.callback_timeout_ms", "agent.callback-timeout-ms"}
    );

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        MutablePropertySources sources = environment.getPropertySources();
        Map<String, Object> aliasMap = new HashMap<>();
        for (String[] pair : ALIASES) {
            String legacy = pair[0];
            String modern = pair[1];
            // 仅当旧键存在且新键缺失时复制（显式新键优先）
            if (environment.containsProperty(legacy) && !environment.containsProperty(modern)) {
                aliasMap.put(modern, environment.getProperty(legacy));
            }
        }
        if (!aliasMap.isEmpty()) {
            // 插到最前，确保优先于 application.yml 等文件源中的同名键
            sources.addFirst(new MapPropertySource("agent-legacy-alias", aliasMap));
        }
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }
}
