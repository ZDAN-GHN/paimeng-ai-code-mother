package com.zdan.paimengaicodebackend.platform.controller;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sun.net.httpserver.HttpServer;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentProperties;
import com.zdan.paimengaicodebackend.platform.deployment.PublicApplicationRouteResolver;
import java.io.IOException;
import java.net.InetSocketAddress;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * 公开运行入口（Issue #81 / T-09；AD-017；AC-003）
 *
 * <p>覆盖 AC-003（未注册访问者可访问公开入口）、AD-017 的 404/503 区分，以及健康路径确实
 * 转发到健康 Deployment 而不是 Platform 自己编造内容。
 */
class PlatformPublicApplicationControllerTest {

    private static final long APPLICATION_ID = 460017668615995392L;

    private final PublicApplicationRouteResolver routes = mock(PublicApplicationRouteResolver.class);
    private final PlatformDeploymentProperties properties = new PlatformDeploymentProperties();

    private MockMvc mockMvc;
    private HttpServer upstream;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders
            .standaloneSetup(new PlatformPublicApplicationController(routes, properties))
            .build();
    }

    @AfterEach
    void tearDown() {
        if (upstream != null) {
            upstream.stop(0);
        }
    }

    @Test
    void unpublishedPathAnswersNotFoundWithoutAnyBody() throws Exception {
        when(routes.resolve(APPLICATION_ID))
            .thenReturn(new PublicApplicationRouteResolver.Route(
                PublicApplicationRouteResolver.Status.NOT_PUBLISHED, null, 0));

        mockMvc.perform(get("/apps/{applicationId}/orders", APPLICATION_ID))
            .andExpect(status().isNotFound())
            .andExpect(content().string(""));
    }

    @Test
    void previouslyPublishedPathAnswersServiceUnavailableWithRetryHint() throws Exception {
        when(routes.resolve(APPLICATION_ID))
            .thenReturn(new PublicApplicationRouteResolver.Route(
                PublicApplicationRouteResolver.Status.UNAVAILABLE, null, 0));

        mockMvc.perform(get("/apps/{applicationId}/orders", APPLICATION_ID))
            .andExpect(status().isServiceUnavailable())
            .andExpect(header().string("Retry-After", "30"))
            .andExpect(content().string(""));
    }

    @Test
    void anonymousVisitorReachesTheHealthyDeploymentWithoutPlatformLogin() throws Exception {
        upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        upstream.createContext("/", exchange -> {
            byte[] payload = "served-by-application".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("X-Upstream", "application");
            exchange.sendResponseHeaders(200, payload.length);
            try (var out = exchange.getResponseBody()) {
                out.write(payload);
            }
        });
        upstream.start();
        properties.setInternalPort(upstream.getAddress().getPort());
        when(routes.resolve(APPLICATION_ID)).thenReturn(new PublicApplicationRouteResolver.Route(
            PublicApplicationRouteResolver.Status.LIVE, "127.0.0.1", upstream.getAddress().getPort()));

        mockMvc.perform(get("/apps/{applicationId}/orders", APPLICATION_ID))
            .andExpect(status().isOk())
            .andExpect(content().string("served-by-application"))
            .andExpect(header().string("X-Upstream", "application"));
    }

    @Test
    void upstreamFailureIsReportedAsBadGatewayWithoutLeakingTheApplicationError() throws Exception {
        int closedPort;
        try (java.net.ServerSocket socket = new java.net.ServerSocket(0)) {
            closedPort = socket.getLocalPort();
        }
        when(routes.resolve(APPLICATION_ID)).thenReturn(new PublicApplicationRouteResolver.Route(
            PublicApplicationRouteResolver.Status.LIVE, "127.0.0.1", closedPort));

        mockMvc.perform(get("/apps/{applicationId}/orders", APPLICATION_ID))
            .andExpect(status().isBadGateway())
            .andExpect(content().string(""));
    }

    @Test
    void resolverIsConsultedForEveryVisitorIncludingUnknownApplications() throws Exception {
        when(routes.resolve(anyLong()))
            .thenReturn(new PublicApplicationRouteResolver.Route(
                PublicApplicationRouteResolver.Status.NOT_PUBLISHED, null, 0));

        mockMvc.perform(get("/apps/{applicationId}/", 1L))
            .andExpect(status().isNotFound());
        mockMvc.perform(get("/apps/{applicationId}/", 2L))
            .andExpect(status().isNotFound());
    }
}