package com.zdan.paimengaicodebackend.platform.service;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 受控执行 HTTP 端点的开关（Issue #77 / T-05）。
 *
 * <p><strong>TODO（入站鉴权延后，维护者决策）：该端点组当前无鉴权。禁止部署到共享或公网
 * 环境。</strong>补齐鉴权前，安全性只依赖两条围栏：本开关默认关闭，且端点只接受回环调用方。
 *
 * <p>与 {@code platform.sandbox.enabled} 是两件事：后者控制是否允许持有 Docker API，
 * 前者控制是否把受控执行暴露成 HTTP 接口。二者独立开关，避免「开了执行器就等于开了公网入口」。
 */
@Data
@Component
@ConfigurationProperties(prefix = "platform.execution")
public class PlatformRunExecutionProperties {

    /** 受控执行端点总开关。默认关闭：无鉴权的写入入口不得默认可达。 */
    private boolean enabled = false;
}
