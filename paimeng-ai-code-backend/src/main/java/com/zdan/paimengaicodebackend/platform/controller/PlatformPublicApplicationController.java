package com.zdan.paimengaicodebackend.platform.controller;

import com.zdan.paimengaicodebackend.platform.deployment.PublicApplicationRouteResolver;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Enumeration;
import java.util.Locale;
import java.util.Set;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

/**
 * Application 的公开运行入口（Issue #81 / T-09）
 *
 * <p>AD-017：公开 URL 是 Platform 既有域名下的 {@code /apps/<application-id>/}，
 * {@code application-id} 创建后不变。TLS 由统一 Nginx ingress 终止；本控制器只负责按
 * {@link PublicApplicationRouteResolver} 的裁决挂载或不挂载。
 *
 * <p>AC-003：访问者不需要注册 Platform 账号，因此这里不解析登录态、也不调用任何主体校验。
 * 这与「可以访问公开运行入口」严格分开——Platform 管理操作仍然要求 Owner 身份。
 *
 * <p>本控制器是<b>只读的反向代理</b>：没有创建、停止、检查或回滚 Deployment 的能力，
 * 部署能力全部在 {@code platform.deployment} 内部服务里。
 */
@Slf4j
@RestController
@RequestMapping("/apps/{applicationId}")
public class PlatformPublicApplicationController {

    /**
     * 逐跳首部：转发时必须剥离，否则会把 Platform 与应用之间的连接管理泄漏给对端，
     * 或让上游以为自己支持某种它并不支持的传输。
     */
    private static final Set<String> HOP_BY_HOP = Set.of(
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"
    );

    /** 请求体上限。公开入口不应成为把任意大请求灌进内部容器的通道。 */
    private static final int MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

    private final PublicApplicationRouteResolver routes;
    private final PlatformDeploymentProperties properties;
    private final HttpClient client;

    public PlatformPublicApplicationController(
        PublicApplicationRouteResolver routes,
        PlatformDeploymentProperties properties
    ) {
        this.routes = routes;
        this.properties = properties;
        this.client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(Math.max(1, properties.getProxyTimeoutSeconds() / 3)))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    }

    @RequestMapping(path = "/**", method = {
        RequestMethod.GET, RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH,
        RequestMethod.DELETE, RequestMethod.HEAD, RequestMethod.OPTIONS
    })
    public void forward(
        @PathVariable Long applicationId,
        HttpServletRequest request,
        HttpServletResponse response
    ) throws IOException {
        PublicApplicationRouteResolver.Route route = routes.resolve(applicationId);
        switch (route.status()) {
            case NOT_PUBLISHED -> {
                // 与「该路径不存在」完全相同的外观，不泄露 Application 是否存在。
                response.setStatus(HttpServletResponse.SC_NOT_FOUND);
            }
            case UNAVAILABLE -> {
                response.setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
                response.setHeader("Retry-After", "30");
            }
            case LIVE -> proxy(applicationId, route, request, response);
            default -> response.setStatus(HttpServletResponse.SC_NOT_FOUND);
        }
    }

    private void proxy(
        Long applicationId,
        PublicApplicationRouteResolver.Route route,
        HttpServletRequest request,
        HttpServletResponse response
    ) throws IOException {
        byte[] body = readBounded(request.getInputStream());
        HttpRequest.Builder upstream = HttpRequest.newBuilder()
            .uri(URI.create(targetUri(applicationId, route, request)))
            .timeout(Duration.ofSeconds(Math.max(1, properties.getProxyTimeoutSeconds())));
        copyRequestHeaders(request, upstream);
        HttpRequest.BodyPublisher publisher = body == null
            ? HttpRequest.BodyPublishers.noBody()
            : HttpRequest.BodyPublishers.ofByteArray(body);
        upstream.method(request.getMethod(), publisher);

        HttpResponse<InputStream> upstreamResponse;
        try {
            upstreamResponse = client.send(upstream.build(), HttpResponse.BodyHandlers.ofInputStream());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            respondBadGateway(response);
            return;
        } catch (IOException | RuntimeException upstreamUnreachable) {
            // 应用侧故障不外泄其异常类型或内容。
            log.error("Platform public application upstream unreachable, applicationId: {}", applicationId);
            respondBadGateway(response);
            return;
        }

        response.setStatus(upstreamResponse.statusCode());
        copyResponseHeaders(upstreamResponse, response);
        try (InputStream in = upstreamResponse.body()) {
            copyBounded(in, response.getOutputStream());
        } catch (IOException brokenPipe) {
            // 客户端提前断开：已经写出去的状态码就是最终结论，无需补偿。
            log.debug("Platform public application client disconnected, applicationId: {}", applicationId);
        }
    }

    private String targetUri(
        Long applicationId,
        PublicApplicationRouteResolver.Route route,
        HttpServletRequest request
    ) {
        String prefix = request.getContextPath() + "/apps/" + applicationId;
        String path = request.getRequestURI();
        String remainder = path.length() >= prefix.length() ? path.substring(prefix.length()) : "/";
        String query = request.getQueryString();
        return "http://" + route.host() + ":" + route.port()
            + (remainder.isEmpty() ? "/" : remainder)
            + (query == null || query.isBlank() ? "" : "?" + query);
    }

    private void copyRequestHeaders(HttpServletRequest request, HttpRequest.Builder builder) {
        Enumeration<String> names = request.getHeaderNames();
        while (names != null && names.hasMoreElements()) {
            String name = names.nextElement();
            if (name == null || HOP_BY_HOP.contains(name.toLowerCase(Locale.ROOT))) {
                continue;
            }
            Enumeration<String> values = request.getHeaders(name);
            while (values != null && values.hasMoreElements()) {
                builder.header(name, values.nextElement());
            }
        }
        // Content-Length 由 BodyPublisher 决定：JDK HttpClient 拒绝手工设置该首部，
        // 逐跳首部表里也刻意包含它，避免把上游的长度声明原样带给内部容器。
    }

    private void copyResponseHeaders(HttpResponse<InputStream> upstream, HttpServletResponse response) {
        upstream.headers().map().forEach((name, values) -> {
            if (name == null || HOP_BY_HOP.contains(name.toLowerCase(Locale.ROOT))) {
                return;
            }
            for (String value : values) {
                response.addHeader(name, value);
            }
        });
    }

    private byte[] readBounded(InputStream input) throws IOException {
        byte[] buffer = new byte[8192];
        java.io.ByteArrayOutputStream collected = new java.io.ByteArrayOutputStream();
        int read;
        while ((read = input.read(buffer)) >= 0) {
            if (collected.size() + read > MAX_REQUEST_BODY_BYTES) {
                throw new IOException("公开入口请求体超过上限");
            }
            collected.write(buffer, 0, read);
        }
        return collected.size() == 0 ? null : collected.toByteArray();
    }

    private void copyBounded(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[8192];
        int written = 0;
        int read;
        while ((read = input.read(buffer)) >= 0) {
            written += read;
            if (written > properties.getMaxProxiedResponseBytes()) {
                throw new IOException("公开入口响应体超过上限");
            }
            output.write(buffer, 0, read);
        }
    }

    private void respondBadGateway(HttpServletResponse response) {
        response.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
    }
}