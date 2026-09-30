package com.zdan.paimengaicodebackend.platform.deployment;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.mapper.platform.PlatformDeploymentMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformReleaseMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRelease;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 公开运行路径的裁决（Issue #81 / T-09；AD-017）
 *
 * <p>三种对外结果必须互不混淆：从未发布与首次部署失败都是 {@code 404}（路径上确实什么都没有），
 * 只有「曾经公开过、现在暂时不可服务」才是 {@code 503}。把两者混同会让 404 变成存在性预言机，
 * 或让访问者无法区分重试与换地址。
 */
class PublicApplicationRouteResolverTest {

    private static final long APPLICATION_ID = 460017668615995392L;

    private final PlatformReleaseMapper releases = mock(PlatformReleaseMapper.class);
    private final PlatformDeploymentMapper deployments = mock(PlatformDeploymentMapper.class);
    private final PlatformDeploymentProperties properties = new PlatformDeploymentProperties();

    private PublicApplicationRouteResolver resolver;

    @BeforeEach
    void setUp() {
        resolver = new PublicApplicationRouteResolver(releases, deployments, properties);
        when(releases.selectOneByQuery(any())).thenReturn(null);
        when(deployments.selectHealthyForApplication(APPLICATION_ID)).thenReturn(null);
        when(deployments.countEverHealthy(APPLICATION_ID)).thenReturn(0);
    }

    @Test
    void applicationWithoutAnyReleaseIsNotPublished() {
        PublicApplicationRouteResolver.Route route = resolver.resolve(APPLICATION_ID);

        assertEquals(PublicApplicationRouteResolver.Status.NOT_PUBLISHED, route.status());
        org.junit.jupiter.api.Assertions.assertNull(route.host());
    }

    @Test
    void firstDeploymentFailureLooksExactlyLikeAnUnpublishedPath() {
        when(releases.selectOneByQuery(any())).thenReturn(release());
        when(deployments.countEverHealthy(APPLICATION_ID)).thenReturn(0);

        assertEquals(PublicApplicationRouteResolver.Status.NOT_PUBLISHED,
            resolver.resolve(APPLICATION_ID).status());
    }

    @Test
    void previouslyPublishedApplicationWithoutHealthyDeploymentIsTemporarilyUnavailable() {
        when(releases.selectOneByQuery(any())).thenReturn(release());
        when(deployments.countEverHealthy(APPLICATION_ID)).thenReturn(1);

        assertEquals(PublicApplicationRouteResolver.Status.UNAVAILABLE,
            resolver.resolve(APPLICATION_ID).status());
    }

    @Test
    void healthyDeploymentIsTheOnlySourceOfALiveRoute() {
        PlatformDeployment healthy = new PlatformDeployment();
        healthy.setContainerAddress("172.18.0.9");
        when(deployments.selectHealthyForApplication(APPLICATION_ID)).thenReturn(healthy);

        PublicApplicationRouteResolver.Route route = resolver.resolve(APPLICATION_ID);

        assertEquals(PublicApplicationRouteResolver.Status.LIVE, route.status());
        assertEquals("172.18.0.9", route.host());
        assertEquals(properties.getInternalPort(), route.port());
    }

    @Test
    void invalidApplicationIdentifierNeverResolves() {
        assertEquals(PublicApplicationRouteResolver.Status.NOT_PUBLISHED, resolver.resolve(null).status());
        assertEquals(PublicApplicationRouteResolver.Status.NOT_PUBLISHED, resolver.resolve(0L).status());
        assertEquals(PublicApplicationRouteResolver.Status.NOT_PUBLISHED, resolver.resolve(-1L).status());
    }

    private PlatformRelease release() {
        PlatformRelease release = new PlatformRelease();
        release.setId("rel-0123456789abcdef0123456789abcdef");
        release.setApplicationId(APPLICATION_ID);
        return release;
    }
}