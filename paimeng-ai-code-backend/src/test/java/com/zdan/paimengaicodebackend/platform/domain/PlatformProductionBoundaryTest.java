package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.zdan.paimengaicodebackend.platform.controller.PlatformRunExecutionController;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentExecutor;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentHealthProbe;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentService;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentStateService;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Production 独占权的结构性断言（Issue #81 / T-09；CST-010；AD-016）
 *
 * <p>验收要求「Agent 无法访问生产密钥、数据库、构建、迁移、流量或回滚操作」。这条边界最可靠的
 * 表达方式是<b>结构</b>：部署能力没有任何 HTTP 端点，因此不存在能被 Agent 调用的路径。
 * 只靠注释和约定，下一次有人「顺手加个调试端点」就会静默打破它，所以这里用类路径扫描把边界钉死。
 *
 * <p>扫描而非硬编码类清单：新 Controller 会自动纳入检查，而不是靠人记得把它加进列表。
 */
class PlatformProductionBoundaryTest {

    /**
     * 路径里出现这些片段，就意味着存在对外的生产操作入口。
     *
     * <p>片段按「生产资源的复数资源名」选取，而不是按 {@code release} 这类宽泛词：
     * {@code /platform/runs/execution/lease/release} 是 Agent 归还 Lease，与创建固定 Release
     * 毫无关系，用宽泛词会把合法的受控执行端点误判成生产入口。
     */
    private static final List<String> FORBIDDEN_PATH_FRAGMENTS = List.of(
        "releases", "deployments", "deploy", "rollback", "production",
        "traffic", "secrets", "migrations", "publish"
    );

    /** 允许暴露给 Agent 的受控执行端点全集；新增端点必须同步登记，否则本测试失败。 */
    private static final Set<String> ALLOWED_AGENT_REACHABLE_PATHS = Set.of(
        "/platform/runs/execution/lease",
        "/platform/runs/execution/recovery/prepare",
        "/platform/runs/execution/recovery/begin",
        "/platform/runs/execution/lease/renew",
        "/platform/runs/execution/lease/release",
        "/platform/runs/execution/commands",
        "/platform/runs/execution/snapshots/freeze",
        "/platform/runs/execution/results",
        "/platform/runs/execution/blocks",
        "/platform/runs/execution/capabilities"
    );

    /**
     * 只扫描 Platform 自己的控制器包。
     *
     * <p>边界要防的是「Platform 把生产能力暴露给 Agent」。{@code AppController#deployApp} 与
     * {@code StaticResourceController} 属于改造前的本地演示链路（{@code /app/deploy} +
     * {@code /static/&#123;deployKey&#125;/**}），既不是 Platform 生产路径也不对 Agent 开放；
     * AD-017 要求它们不得成为新的 Platform 公开入口，因此下面另有一条断言专门盯这件事。
     */
    private static final String CONTROLLER_PACKAGE = "com.zdan.paimengaicodebackend.platform.controller";

    @Test
    void noHttpEndpointExistsForDeploymentOrReleaseOperations() {
        List<String> offenders = new ArrayList<>();
        for (Class<?> controller : scanControllers()) {
            for (Method method : controller.getDeclaredMethods()) {
                for (String path : mappedPaths(controller, method)) {
                    String normalized = path.toLowerCase(Locale.ROOT);
                    for (String fragment : FORBIDDEN_PATH_FRAGMENTS) {
                        if (normalized.contains(fragment)) {
                            offenders.add(controller.getSimpleName() + "#" + method.getName() + " -> " + path);
                        }
                    }
                }
            }
        }
        if (!offenders.isEmpty()) {
            fail("存在生产操作 HTTP 端点，Agent 将能直接触达: " + offenders);
        }
    }

    @Test
    void productionExecutionServicesAreNotHttpReachableAtAll() {
        for (Class<?> service : List.of(PlatformDeploymentService.class,
            PlatformDeploymentStateService.class, PlatformDeploymentExecutor.class,
            PlatformDeploymentHealthProbe.class)) {
            assertTrue(!service.isAnnotationPresent(RestController.class),
                service.getSimpleName() + " 不得是 Controller");
            assertTrue(!service.isAnnotationPresent(RequestMapping.class),
                service.getSimpleName() + " 不得声明任何请求映射");
        }
    }

    /**
     * AD-017：新的 Platform 公开入口是 {@code /apps/<application-id>/}，不是改造前的
     * {@code /static/&#123;deployKey&#125;/**} 演示路径。固定模板因此必须支持 path base，
     * 这条断言保证公开入口不会退回 deployKey 形态。
     */
    @Test
    void platformPublicEntryIsPathBaseScopedAndNotADeployKeyRoute() {
        List<Class<?>> controllers = scanControllers();
        List<String> publicPaths = new ArrayList<>();
        for (Class<?> controller : controllers) {
            for (Method method : controller.getDeclaredMethods()) {
                publicPaths.addAll(mappedPaths(controller, method));
            }
        }
        List<String> appsScoped = publicPaths.stream().filter(path -> path.startsWith("/apps")).toList();
        assertTrue(!appsScoped.isEmpty(),
            "缺少 /apps/<application-id>/ 公开入口；已扫描控制器: " + controllers.stream()
                .map(Class::getSimpleName).toList() + "，已扫描路径: " + publicPaths);
        assertTrue(appsScoped.stream().allMatch(path -> path.contains("{applicationId}")),
            "公开入口必须按 Application 标识分路径: " + appsScoped);
        assertTrue(publicPaths.stream().noneMatch(path -> path.contains("deployKey")),
            "Platform 控制器不得再提供 deployKey 形态的公开入口: " + publicPaths);
    }

    @Test
    void agentReachableExecutionSurfaceStaysExactlyTheClosedSet() {
        List<String> mapped = new ArrayList<>();
        for (Method method : PlatformRunExecutionController.class.getDeclaredMethods()) {
            mapped.addAll(mappedPaths(PlatformRunExecutionController.class, method));
        }
        List<String> unexpected = mapped.stream()
            .filter(path -> !ALLOWED_AGENT_REACHABLE_PATHS.contains(path))
            .toList();
        assertTrue(unexpected.isEmpty(), "出现了未登记的 Agent 可达端点: " + unexpected);
        List<String> missing = ALLOWED_AGENT_REACHABLE_PATHS.stream()
            .filter(path -> !mapped.contains(path))
            .toList();
        assertTrue(missing.isEmpty(), "受控执行端点缺失: " + missing);
    }

    private List<Class<?>> scanControllers() {
        ClassPathScanningCandidateComponentProvider scanner =
            new ClassPathScanningCandidateComponentProvider(false);
        // 扫描器默认会按 @Conditional 过滤候选类，而受控执行端点带
        // @ConditionalOnProperty(platform.execution.enabled)。这里显式打开该开关：
        // 本测试要检查的是「代码里存在哪些端点」，而不是「当前配置下启用了哪些端点」，
        // 否则只要开关关着，一次违规新增就能完全躲开检查。
        scanner.setEnvironment(new MockEnvironment().withProperty("platform.execution.enabled", "true"));
        scanner.addIncludeFilter(new AnnotationTypeFilter(RestController.class));
        List<Class<?>> controllers = new ArrayList<>();
        scanner.findCandidateComponents(CONTROLLER_PACKAGE).forEach(beanDefinition -> {
            try {
                controllers.add(Class.forName(beanDefinition.getBeanClassName()));
            } catch (ClassNotFoundException | LinkageError unreadable) {
                fail("无法加载 Controller 类: " + beanDefinition.getBeanClassName());
            }
        });
        return controllers;
    }

    /**
     * 收集一个 Controller（或单个方法）的全部映射路径。
     *
     * @param method 为 null 时只返回类级前缀
     */
    private List<String> mappedPaths(Class<?> controller, Method method) {
        RequestMapping classMapping = controller.getAnnotation(RequestMapping.class);
        String base = classMapping == null || classMapping.value().length == 0 ? "" : classMapping.value()[0];
        List<String> suffixes = new ArrayList<>();
        if (method != null) {
            addAll(suffixes, method.getAnnotation(RequestMapping.class));
            addAll(suffixes, method.getAnnotation(GetMapping.class));
            addAll(suffixes, method.getAnnotation(PostMapping.class));
            addAll(suffixes, method.getAnnotation(PutMapping.class));
            addAll(suffixes, method.getAnnotation(DeleteMapping.class));
            addAll(suffixes, method.getAnnotation(PatchMapping.class));
        }
        return suffixes.stream().map(suffix -> base + suffix).toList();
    }

    /**
     * {@code @RequestMapping} 的路径可以写在 {@code value} 或 {@code path} 上，两者互为别名。
     * 只读 {@code value} 会漏掉写成 {@code path = "/**"} 的映射——公开入口正是这种写法。
     */
    private void addAll(List<String> target, RequestMapping mapping) {
        if (mapping != null) {
            addAll(target, mapping.value());
            for (String path : mapping.path()) {
                if (!target.contains(path)) {
                    target.add(path);
                }
            }
        }
    }

    private void addAll(List<String> target, GetMapping mapping) {
        if (mapping != null) {
            addAll(target, mapping.value());
        }
    }

    private void addAll(List<String> target, PostMapping mapping) {
        if (mapping != null) {
            addAll(target, mapping.value());
        }
    }

    private void addAll(List<String> target, PutMapping mapping) {
        if (mapping != null) {
            addAll(target, mapping.value());
        }
    }

    private void addAll(List<String> target, DeleteMapping mapping) {
        if (mapping != null) {
            addAll(target, mapping.value());
        }
    }

    private void addAll(List<String> target, PatchMapping mapping) {
        if (mapping != null) {
            addAll(target, mapping.value());
        }
    }

    private void addAll(List<String> target, String[] values) {
        for (String value : values) {
            target.add(value);
        }
    }
}