package com.zdan.paimengaicodemother.controller;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.mybatisflex.core.paginate.Page;
import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodemother.ai.python.PythonAgentCallbackRequest;
import com.zdan.paimengaicodemother.ai.python.RunIdSinkRegistry;
import com.zdan.paimengaicodemother.annotation.AuthCheck;
import com.zdan.paimengaicodemother.common.BaseResponse;
import com.zdan.paimengaicodemother.common.DeleteRequest;
import com.zdan.paimengaicodemother.common.ResultUtils;
import com.zdan.paimengaicodemother.config.PythonAgentProperties;
import com.zdan.paimengaicodemother.constant.AppConstant;
import com.zdan.paimengaicodemother.constant.UserConstant;
import com.zdan.paimengaicodemother.core.builder.BuilderExecutor;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.model.dto.app.*;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.enums.ChatHistoryMessageTypeEnum;
import com.zdan.paimengaicodemother.model.vo.AppVO;
import com.zdan.paimengaicodemother.ratelimiter.annotaion.RateLimit;
import com.zdan.paimengaicodemother.ratelimiter.enums.RateLimitType;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import com.zdan.paimengaicodemother.service.ProjectDownloadService;
import com.zdan.paimengaicodemother.service.UserService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.io.File;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 应用 控制层。
 *
 * @author LXH
 */
@Slf4j
@RestController
@RequestMapping("/app")
public class AppController {

    private final AppService appService;
    private final UserService userService;
    private final ProjectDownloadService projectDownloadService;
    private final PythonAgentProperties pythonAgentProperties;
    private final RunIdSinkRegistry runIdSinkRegistry;
    private final ChatHistoryService chatHistoryService;

    public AppController(AppService appService,
                         UserService userService,
                         ProjectDownloadService projectDownloadService,
                         PythonAgentProperties pythonAgentProperties,
                         RunIdSinkRegistry runIdSinkRegistry,
                         ChatHistoryService chatHistoryService) {
        this.appService = appService;
        this.userService = userService;
        this.projectDownloadService = projectDownloadService;
        this.pythonAgentProperties = pythonAgentProperties;
        this.runIdSinkRegistry = runIdSinkRegistry;
        this.chatHistoryService = chatHistoryService;
    }

    /**
     * 下载应用代码
     *
     * @param appId    应用ID
     * @param request  请求
     * @param response 响应
     */
    @GetMapping("/download/{appId}")
    public void downloadAppCode(@PathVariable Long appId,
                                HttpServletRequest request,
                                HttpServletResponse response) {

        // 1. 基础校验
        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "应用ID无效");

        // 2. 查询应用信息
        App app = appService.getById(appId);
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR, "应用不存在");

        // 3. 权限检验：只有应用创建者可以下载代码
        User loginUser = userService.getLoginUser(request);
        if (!app.getUserId().equals(loginUser.getId())) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "无权限下载该应用代码");
        }

        // 4. 构建应用代码目录路径（生成目录，非部署目录）
        String codeGenType = app.getCodeGenType();
        String sourceDirName = codeGenType + "_" + appId;
        String sourceDirPath = AppConstant.CODE_OUTPUT_ROOT_DIR + File.separator + sourceDirName;

        // 5. 检查代码目录是否存在
        File sourceDir = new File(sourceDirPath);
        ThrowUtils.throwIf(!sourceDir.exists() || !sourceDir.isDirectory(),
                ErrorCode.NOT_FOUND_ERROR, "应用代码不存在，请先生成代码");

        // 6. 生成下载文件名（不建议添加中文内容）
        String downloadFileName = String.valueOf(appId);

        // 7. 调用通用下载服务
        projectDownloadService.downloadProjectAsZip(sourceDirPath, downloadFileName, response);
    }

    /**
     * 应用部署
     *
     * @param appDeployRequest 部署请求
     * @param request          请求
     * @return 部署 URL
     */
    @PostMapping("/deploy")
    public BaseResponse<String> deployApp(@RequestBody AppDeployRequest appDeployRequest, HttpServletRequest request) {
        ThrowUtils.throwIf(appDeployRequest == null, ErrorCode.PARAMS_ERROR);
        Long appId = appDeployRequest.getAppId();
        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "应用 ID 不能为空");
        // 获取当前登录用户
        User loginUser = userService.getLoginUser(request);
        // 调用服务部署应用
        String deployUrl = appService.deployApp(appId, loginUser);
        return ResultUtils.success(deployUrl);
    }

    /**
     * ai 对话生成代码
     */
    @GetMapping(value = "/chat/gen/code", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    // 1 分钟内最多允许请求 5 次，采用根据用户类型进行限流
    @RateLimit(limitType = RateLimitType.USER, rate = 1, rateInterval = 60, message = "AI 对话请求过于频繁，请稍后再试")
    public Flux<ServerSentEvent<String>> chatToGenCode(@RequestParam Long appId,
                                                       @RequestParam String message,
                                                       HttpServletRequest request) {
        if (appId == null || appId <= 0) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "应用 id 错误");
        }
        if (StrUtil.isBlank(message)) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "提示词不能为空");
        }
        // 获取当前用户
        User loginUser = userService.getLoginUser(request);
        // 调用服务生成代码（SSE 流式返回，含文本事件与终端 done / business-error）
        return appService.chatToGenCode(appId, message, loginUser);
    }

    /**
     * Python Agent 完成回调（§1.4，内部接口）
     * 不走用户鉴权（Python 无 session Cookie），仅校验 Bearer；runId 幂等；
     * 首次处理：success → 构建 + 向浏览器发 done；failed → 写错误历史 + business-error
     *
     * @param body          回调请求体
     * @param authorization Authorization 头
     * @return 处理结果
     */
    @PostMapping("/chat/gen/code/callback")
    public BaseResponse<Boolean> pythonAgentCallback(@RequestBody PythonAgentCallbackRequest body,
                                                     @RequestHeader(value = "Authorization", required = false) String authorization) {
        // 仅校验内部 Bearer 令牌（A4：回调 handler 不取 session）
        String expected = "Bearer " + pythonAgentProperties.getToken();
        if (StrUtil.isBlank(pythonAgentProperties.getToken()) || !expected.equals(authorization)) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "非法调用");
        }
        ThrowUtils.throwIf(body == null || StrUtil.isBlank(body.getRunId()), ErrorCode.PARAMS_ERROR, "runId 不能为空");
        // status 仅接受 success/failed（A9），非法值返回 400
        String status = body.getStatus();
        if (!"success".equals(status) && !"failed".equals(status)) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "status 仅接受 success/failed");
        }
        String runId = body.getRunId();
        // 幂等：已处理过 / 已超时移除 / 不存在 → 直接返回 200 丢弃（防重试 / 超时兜底重复处理）
        if (!runIdSinkRegistry.tryMarkProcessed(runId)) {
            return ResultUtils.success(true);
        }
        Optional<RunIdSinkRegistry.Entry> entryOpt = runIdSinkRegistry.get(runId);
        if (entryOpt.isEmpty()) {
            // 条目已被移除（如超时兜底已处理），迟到的回调直接丢弃
            return ResultUtils.success(true);
        }
        RunIdSinkRegistry.Entry entry = entryOpt.get();
        if ("success".equals(status)) {
            // 成功历史已在主通道流结束时由 handler 写入（与旧链路一致，见 docs/py_agent/progress.md）
            // 此处执行构建并向浏览器发送 done
            try {
                BuilderExecutor.doBuild(entry.getCodeGenType(), entry.getWorkspacePath());
            } catch (Exception e) {
                log.error("回调构建失败，runId: {}, cause: {}", runId, e.getMessage());
            }
            runIdSinkRegistry.complete(runId, doneSse());
        } else {
            // 失败：写错误历史 + 浏览器 business-error
            String errorMessage = StrUtil.blankToDefault(body.getMessage(), "生成失败");
            chatHistoryService.addChatMessage(entry.getAppId(), "生成失败：" + errorMessage,
                    ChatHistoryMessageTypeEnum.AI.getValue(), entry.getLoginUser());
            runIdSinkRegistry.complete(runId, businessErrorSse(ErrorCode.OPERATION_ERROR, errorMessage));
        }
        return ResultUtils.success(true);
    }

    /**
     * 完成事件（event: done）
     *
     * @return SSE 事件
     */
    private ServerSentEvent<String> doneSse() {
        return ServerSentEvent.<String>builder().event("done").build();
    }

    /**
     * 业务错误事件（event: business-error）
     *
     * @param code    错误码
     * @param message 错误消息
     * @return SSE 事件
     */
    private ServerSentEvent<String> businessErrorSse(ErrorCode code, String message) {
        return ServerSentEvent.<String>builder()
                .event("business-error")
                .data(JSONUtil.toJsonStr(Map.of("error", true, "code", code.getCode(), "message", message)))
                .build();
    }

    /**
     * 创建应用
     *
     * @param appAddRequest 创建应用请求
     * @param request       请求
     * @return 应用 id
     */
    @PostMapping("/add")
    public BaseResponse<Long> addApp(@RequestBody AppAddRequest appAddRequest, HttpServletRequest request) {
        ThrowUtils.throwIf(appAddRequest == null, ErrorCode.PARAMS_ERROR);
        // 获取当前登录用户
        User loginUser = userService.getLoginUser(request);
        // 创建应用
        Long appId = appService.createApp(appAddRequest, loginUser);
        return ResultUtils.success(appId);
    }

    /**
     * 更新应用（用户只能更新自己的应用名称）
     *
     * @param appUpdateRequest 更新请求
     * @param request          请求
     * @return 更新结果
     */
    @PostMapping("/update")
    public BaseResponse<Boolean> updateApp(@RequestBody AppUpdateRequest appUpdateRequest, HttpServletRequest request) {
        if (appUpdateRequest == null || appUpdateRequest.getId() == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        User loginUser = userService.getLoginUser(request);
        long id = appUpdateRequest.getId();
        // 判断是否存在
        App oldApp = appService.getById(id);
        ThrowUtils.throwIf(oldApp == null, ErrorCode.NOT_FOUND_ERROR);
        // 仅本人可更新
        if (!oldApp.getUserId().equals(loginUser.getId())) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR);
        }
        App app = new App();
        app.setId(id);
        app.setAppName(appUpdateRequest.getAppName());
        // 设置编辑时间
        app.setEditTime(LocalDateTime.now());
        boolean result = appService.updateById(app);
        ThrowUtils.throwIf(!result, ErrorCode.OPERATION_ERROR);
        return ResultUtils.success(true);
    }

    /**
     * 删除应用（用户只能删除自己的应用）
     *
     * @param deleteRequest 删除请求
     * @param request       请求
     * @return 删除结果
     */
    @PostMapping("/delete")
    public BaseResponse<Boolean> deleteApp(@RequestBody DeleteRequest deleteRequest, HttpServletRequest request) {
        if (deleteRequest == null || deleteRequest.getId() <= 0) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        User loginUser = userService.getLoginUser(request);
        long id = deleteRequest.getId();
        // 判断是否存在
        App oldApp = appService.getById(id);
        ThrowUtils.throwIf(oldApp == null, ErrorCode.NOT_FOUND_ERROR);
        // 仅本人或管理员可删除
        if (!oldApp.getUserId().equals(loginUser.getId()) && !UserConstant.ADMIN_ROLE.equals(loginUser.getUserRole())) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR);
        }
        boolean result = appService.removeById(id);
        return ResultUtils.success(result);
    }

    /**
     * 根据 id 获取应用详情
     *
     * @param id 应用 id
     * @return 应用详情
     */
    @GetMapping("/get/vo")
    public BaseResponse<AppVO> getAppVOById(long id) {
        ThrowUtils.throwIf(id <= 0, ErrorCode.PARAMS_ERROR);
        // 查询数据库
        App app = appService.getById(id);
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR);
        // 获取封装类（包含用户信息）
        return ResultUtils.success(appService.getAppVO(app));
    }

    /**
     * 分页获取当前用户创建的应用列表
     *
     * @param appQueryRequest 查询请求
     * @param request         请求
     * @return 应用列表
     */
    @PostMapping("/my/list/page/vo")
    public BaseResponse<Page<AppVO>> listMyAppVOByPage(@RequestBody AppQueryRequest appQueryRequest,
                                                       HttpServletRequest request) {
        ThrowUtils.throwIf(appQueryRequest == null, ErrorCode.PARAMS_ERROR);
        User loginUser = userService.getLoginUser(request);

        // 限制每页最多 20 个
        long pageSize = appQueryRequest.getPageSize();
        ThrowUtils.throwIf(pageSize > 20, ErrorCode.PARAMS_ERROR, "每页最多查询 20 个应用");
        long pageNum = appQueryRequest.getPageNum();

        // 只查询当前用户的应用
        appQueryRequest.setUserId(loginUser.getId());
        QueryWrapper queryWrapper = appService.getQueryWrapper(appQueryRequest);
        Page<App> appPage = appService.page(Page.of(pageNum, pageSize), queryWrapper);

        // 数据封装
        Page<AppVO> appVOPage = new Page<>(pageNum, pageSize, appPage.getTotalRow());
        List<AppVO> appVOList = appService.getAppVOList(appPage.getRecords());
        appVOPage.setRecords(appVOList);

        return ResultUtils.success(appVOPage);
    }

    /**
     * 分页获取精选应用列表
     *
     * @param appQueryRequest 查询请求
     * @return 精选应用列表
     */
    @PostMapping("/good/list/page/vo")
    @Cacheable(
            value = "good_app_page", // 缓存空间（key 的前缀）
            key = "T(com.zdan.paimengaicodemother.utils.CacheKeyUtils).generateKey(#appQueryRequest)", // 空间下的键名
            condition = "#appQueryRequest.pageNum <= 10" // 触发查询缓存的条件（缓存如果未命中就执行方法之后将返回值缓存，这个注解本质是 aop 切面）
    )
    public BaseResponse<Page<AppVO>> listGoodAppVOByPage(@RequestBody AppQueryRequest appQueryRequest) {
        ThrowUtils.throwIf(appQueryRequest == null, ErrorCode.PARAMS_ERROR);
        // 限制每页最多 20 个
        long pageSize = appQueryRequest.getPageSize();
        ThrowUtils.throwIf(pageSize > 20, ErrorCode.PARAMS_ERROR, "每页最多查询 20 个应用");
        long pageNum = appQueryRequest.getPageNum();

        // 只查询精选的应用
        appQueryRequest.setPriority(AppConstant.GOOD_APP_PRIORITY);
        QueryWrapper queryWrapper = appService.getQueryWrapper(appQueryRequest);
        // 分页查询
        Page<App> appPage = appService.page(Page.of(pageNum, pageSize), queryWrapper);

        // 数据封装
        Page<AppVO> appVOPage = new Page<>(pageNum, pageSize, appPage.getTotalRow());
        List<AppVO> appVOList = appService.getAppVOList(appPage.getRecords());
        appVOPage.setRecords(appVOList);

        return ResultUtils.success(appVOPage);
    }

    /**
     * 管理员删除应用
     *
     * @param deleteRequest 删除请求
     * @return 删除结果
     */
    @PostMapping("/admin/delete")
    @AuthCheck(mustRole = UserConstant.ADMIN_ROLE)
    public BaseResponse<Boolean> deleteAppByAdmin(@RequestBody DeleteRequest deleteRequest) {
        if (deleteRequest == null || deleteRequest.getId() <= 0) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        long id = deleteRequest.getId();
        // 判断是否存在
        App oldApp = appService.getById(id);
        ThrowUtils.throwIf(oldApp == null, ErrorCode.NOT_FOUND_ERROR);
        boolean result = appService.removeById(id);
        return ResultUtils.success(result);
    }

    /**
     * 管理员更新应用
     *
     * @param appAdminUpdateRequest 更新请求
     * @return 更新结果
     */
    @PostMapping("/admin/update")
    @AuthCheck(mustRole = UserConstant.ADMIN_ROLE)
    public BaseResponse<Boolean> updateAppByAdmin(@RequestBody AppAdminUpdateRequest appAdminUpdateRequest) {
        if (appAdminUpdateRequest == null || appAdminUpdateRequest.getId() == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        long id = appAdminUpdateRequest.getId();
        // 判断是否存在
        App oldApp = appService.getById(id);
        ThrowUtils.throwIf(oldApp == null, ErrorCode.NOT_FOUND_ERROR);
        App app = new App();
        BeanUtil.copyProperties(appAdminUpdateRequest, app);
        // 设置编辑时间
        app.setEditTime(LocalDateTime.now());
        boolean result = appService.updateById(app);
        ThrowUtils.throwIf(!result, ErrorCode.OPERATION_ERROR);
        return ResultUtils.success(true);
    }

    /**
     * 管理员分页获取应用列表
     *
     * @param appQueryRequest 查询请求
     * @return 应用列表
     */
    @PostMapping("/admin/list/page/vo")
    @AuthCheck(mustRole = UserConstant.ADMIN_ROLE)
    public BaseResponse<Page<AppVO>> listAppVOByPageByAdmin(@RequestBody AppQueryRequest appQueryRequest) {
        ThrowUtils.throwIf(appQueryRequest == null, ErrorCode.PARAMS_ERROR);
        long pageNum = appQueryRequest.getPageNum();
        long pageSize = appQueryRequest.getPageSize();
        QueryWrapper queryWrapper = appService.getQueryWrapper(appQueryRequest);
        Page<App> appPage = appService.page(Page.of(pageNum, pageSize), queryWrapper);

        // 数据封装
        Page<AppVO> appVOPage = new Page<>(pageNum, pageSize, appPage.getTotalRow());
        List<AppVO> appVOList = appService.getAppVOList(appPage.getRecords());
        appVOPage.setRecords(appVOList);

        return ResultUtils.success(appVOPage);
    }

    /**
     * 管理员根据 id 获取应用详情
     *
     * @param id 应用 id
     * @return 应用详情
     */
    @GetMapping("/admin/get/vo")
    @AuthCheck(mustRole = UserConstant.ADMIN_ROLE)
    public BaseResponse<AppVO> getAppVOByIdByAdmin(long id) {
        ThrowUtils.throwIf(id <= 0, ErrorCode.PARAMS_ERROR);
        // 查询数据库
        App app = appService.getById(id);
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR);
        // 获取封装类
        return ResultUtils.success(appService.getAppVO(app));
    }
}
