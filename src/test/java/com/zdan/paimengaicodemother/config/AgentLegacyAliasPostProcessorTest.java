package com.zdan.paimengaicodemother.config;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * AgentLegacyAliasPostProcessor 单元测试（Issue #6）
 * 验证 python-agent.* → agent.* 别名：旧键存在且新键缺失时复制；新键显式设置时不覆盖。
 *
 * @author LXH
 */
class AgentLegacyAliasPostProcessorTest {

    /**
     * 旧键存在、新键缺失 → 复制到 agent.*
     */
    @Test
    void legacyKeysAreCopiedWhenModernMissing() {
        MockEnvironment env = new MockEnvironment();
        env.setProperty("python-agent.enabled", "false");
        env.setProperty("python-agent.token", "legacy-token");

        new AgentLegacyAliasPostProcessor().postProcessEnvironment(env, null);

        assertEquals("false", env.getProperty("agent.enabled"));
        assertEquals("legacy-token", env.getProperty("agent.token"));
    }

    /**
     * 新键显式设置 → 不覆盖（新配置优先）
     */
    @Test
    void modernKeysWinWhenSet() {
        MockEnvironment env = new MockEnvironment();
        env.setProperty("agent.enabled", "true");
        env.setProperty("python-agent.enabled", "false");

        new AgentLegacyAliasPostProcessor().postProcessEnvironment(env, null);

        assertEquals("true", env.getProperty("agent.enabled"));
    }

    /**
     * 旧键不存在 → 不产生 agent.* 键
     */
    @Test
    void noLegacyKeysYieldsNoAliases() {
        MockEnvironment env = new MockEnvironment();

        new AgentLegacyAliasPostProcessor().postProcessEnvironment(env, null);

        assertNull(env.getProperty("agent.enabled"));
    }
}
