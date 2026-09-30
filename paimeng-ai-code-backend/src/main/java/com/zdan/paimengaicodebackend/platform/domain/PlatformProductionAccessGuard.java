package com.zdan.paimengaicodebackend.platform.domain;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import org.springframework.stereotype.Component;

/**
 * Production 操作的主体围栏（Issue #81 / T-09）
 *
 * <p>CST-010：Platform 独占生产构建、配置与密钥注入、生产 Migration、流量切换、健康检查、
 * 日志和回滚。AD-016 更直接：Agent 永远不能创建、停止、检查或回滚 Deployment。
 *
 * <p>这条边界由三层共同保证，本类是其中唯一一处<b>可执行</b>的判定：
 *
 * <ol>
 *   <li>结构性——部署能力没有任何 Controller，Agent 在 HTTP 上够不着；</li>
 *   <li>接口性——部署状态只能由本类认可的 Platform actor 推进；</li>
 *   <li>测试性——前两层由 {@code PlatformProductionBoundaryTest} 反射断言，不会被后续提交悄悄改掉。</li>
 * </ol>
 *
 * <p>刻意不提供「允许 Agent 例外」的分支：CST-010 没有例外，任何例外都会成为绕过点。
 */
@Component
public class PlatformProductionAccessGuard {

    /**
     * 拒绝任何非 Platform 主体触碰生产执行路径。
     *
     * @param requestedBy 声称要推进生产状态的主体
     * @throws BusinessException 主体不是 Platform（含 {@link PlatformActor#AGENT}）时直接拒绝
     */
    public void requirePlatformActor(PlatformActor requestedBy) {
        if (requestedBy != PlatformActor.PLATFORM) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "生产操作只由 Platform 执行");
        }
    }

    /**
     * 受控诊断是否允许外发。
     *
     * <p>只允许白名单枚举进入对外投影；未登记值一律视为不可外发，而不是原样透传。
     *
     * @param raw 数据库中记录的受控原因码
     * @return 是否可以对外展示该原因码
     */
    public boolean isPublishableReasonCode(String raw) {
        return com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentReasonCode.of(raw) != null;
    }
}