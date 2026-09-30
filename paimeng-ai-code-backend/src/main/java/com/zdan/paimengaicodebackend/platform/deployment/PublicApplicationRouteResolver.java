package com.zdan.paimengaicodebackend.platform.deployment;

import com.zdan.paimengaicodebackend.mapper.platform.PlatformDeploymentMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformReleaseMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRelease;
import org.springframework.stereotype.Component;

/**
 * 公开运行路径的裁决（Issue #81 / T-09）
 *
 * <p>AD-017 给了两种不同的对外结果，判据是「是否曾经存在健康 Deployment」：
 *
 * <ul>
 *   <li>从未健康（含首次部署失败）：路径上什么都没有挂载，返回 {@code 404}。它必须与
 *       「这个 Application 不存在」在外观上不可区分，否则会成为存在性预言机。</li>
 *   <li>曾经健康但当前没有：路径确实存在过、只是暂时不可服务，返回 {@code 503}，
 *       让访问者能区分「稍后重试」与「换地址」。</li>
 * </ul>
 *
 * <p>两种结果都不携带容器、版本、日志或基础设施细节。目标地址只在本类内部流转。
 */
@Component
public class PublicApplicationRouteResolver {

    /** 对外可见的路由裁决。{@link #host()} 与 {@link #port()} 只在 {@link Status#LIVE} 时有值。 */
    public record Route(Status status, String host, int port) { }

    public enum Status {
        /** 有健康 Deployment，路径已挂载。 */
        LIVE,
        /** 路径上没有任何可服务内容，对外表现为 404。 */
        NOT_PUBLISHED,
        /** 路径曾公开但当前无健康 Deployment，对外表现为 503。 */
        UNAVAILABLE
    }

    private final PlatformReleaseMapper releases;
    private final PlatformDeploymentMapper deployments;
    private final PlatformDeploymentProperties properties;

    public PublicApplicationRouteResolver(
        PlatformReleaseMapper releases,
        PlatformDeploymentMapper deployments,
        PlatformDeploymentProperties properties
    ) {
        this.releases = releases;
        this.deployments = deployments;
        this.properties = properties;
    }

    public Route resolve(Long applicationId) {
        if (applicationId == null || applicationId <= 0) {
            return new Route(Status.NOT_PUBLISHED, null, 0);
        }
        PlatformDeployment healthy = deployments.selectHealthyForApplication(applicationId);
        if (healthy != null && healthy.getContainerAddress() != null
            && !healthy.getContainerAddress().isBlank()) {
            return new Route(Status.LIVE, healthy.getContainerAddress(), properties.getInternalPort());
        }
        PlatformRelease release = releases.selectOneByQuery(
            com.mybatisflex.core.query.QueryWrapper.create()
                .eq("appId", applicationId)
                .orderBy("id", false)
                .limit(1));
        if (release == null) {
            return new Route(Status.NOT_PUBLISHED, null, 0);
        }
        return deployments.countEverHealthy(applicationId) > 0
            ? new Route(Status.UNAVAILABLE, null, 0)
            : new Route(Status.NOT_PUBLISHED, null, 0);
    }

    /** 公开路径前缀，仅用于 Owner 投影拼出可点击地址；同样不含任何部署内部信息。 */
    public String publicBasePath() {
        return properties.getPublicBasePath();
    }
}