package com.zdan.paimengaicodemother.service.impl;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.RandomUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodemother.ai.codegen.route.AiCodeGenTypeRoutingService;
import com.zdan.paimengaicodemother.ai.codegen.route.AiCodeGenTypeRoutingServiceFactory;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.ai.python.PythonAgentClient;
import com.zdan.paimengaicodemother.ai.python.PythonAgentRequest;
import com.zdan.paimengaicodemother.ai.python.PythonAgentSseAdapter;
import com.zdan.paimengaicodemother.ai.python.RunIdSinkRegistry;
import com.zdan.paimengaicodemother.config.PythonAgentProperties;
import com.zdan.paimengaicodemother.constant.AppConstant;
import com.zdan.paimengaicodemother.core.AiCodeGeneratorFacade;
import com.zdan.paimengaicodemother.core.builder.BuilderExecutor;
import com.zdan.paimengaicodemother.core.handler.StreamHandlerExecutor;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.mapper.AppMapper;
import com.zdan.paimengaicodemother.model.dto.app.AppAddRequest;
import com.zdan.paimengaicodemother.model.dto.app.AppQueryRequest;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.ChatHistory;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.enums.ChatHistoryMessageTypeEnum;
import com.zdan.paimengaicodemother.model.vo.AppVO;
import com.zdan.paimengaicodemother.model.vo.UserVO;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import com.zdan.paimengaicodemother.service.ScreenshotService;
import com.zdan.paimengaicodemother.service.UserService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.io.File;
import java.io.Serializable;
import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 应用 服务层实现。
 *
 * @author LXH
 */
@Slf4j
@Service
public class AppServiceImpl extends ServiceImpl<AppMapper, App> implements AppService {

    private final UserService userService;
    private final ChatHistoryService chatHistoryService;
    private final AiCodeGeneratorFacade aiCodeGeneratorFacade;
    private final StreamHandlerExecutor streamHandlerExecutor;
    private final ScreenshotService screenshotService;
    private final AiCodeGenTypeRoutingServiceFactory aiCodeGenTypeRoutingServiceFactory;
    private final PythonAgentClient pythonAgentClient;
    private final PythonAgentSseAdapter pythonAgentSseAdapter;
    private final RunIdSinkRegistry runIdSinkRegistry;
    private final PythonAgentProperties pythonAgentProperties;

    public AppServiceImpl(UserService userService,
                          ChatHistoryService chatHistoryService,
                          AiCodeGeneratorFacade aiCodeGeneratorFacade,
                          StreamHandlerExecutor streamHandlerExecutor,
                          ScreenshotService screenshotService,
                          AiCodeGenTypeRoutingServiceFactory aiCodeGenTypeRoutingServiceFactory,
                          PythonAgentClient pythonAgentClient,
                          PythonAgentSseAdapter pythonAgentSseAdapter,
                          RunIdSinkRegistry runIdSinkRegistry,
                          PythonAgentProperties pythonAgentProperties) {
        this.userService = userService;
        this.chatHistoryService = chatHistoryService;
        this.aiCodeGeneratorFacade = aiCodeGeneratorFacade;
        this.streamHandlerExecutor = streamHandlerExecutor;
        this.screenshotService = screenshotService;
        this.aiCodeGenTypeRoutingServiceFactory = aiCodeGenTypeRoutingServiceFactory;
        this.pythonAgentClient = pythonAgentClient;
        this.pythonAgentSseAdapter = pythonAgentSseAdapter;
        this.runIdSinkRegistry = runIdSinkRegistry;
        this.pythonAgentProperties = pythonAgentProperties;
    }

    @Override
    public Long createApp(AppAddRequest appAddRequest, User loginUser) {
        // 参数校验
        String initPrompt = appAddRequest.getInitPrompt();
        ThrowUtils.throwIf(StrUtil.isBlank(initPrompt), ErrorCode.PARAMS_ERROR, "初始化prompt不能为空");

        // 构造入库对象
        App app = new App();
        BeanUtil.copyProperties(appAddRequest, app);
        app.setUserId(loginUser.getId());

        // 应用名称暂时为 initPrompt 前 12 位
        app.setAppName(initPrompt.substring(0, Math.min(initPrompt.length(), 12)));

        // 使用 AI 智能选择代码生成类型（多例模式）
        AiCodeGenTypeRoutingService aiCodeGenTypeRoutingService = aiCodeGenTypeRoutingServiceFactory.createAiCodeGenTypeRoutingService();
        CodeGenTypeEnum selectedCodeGenType = aiCodeGenTypeRoutingService.routeCodeGenType(initPrompt);
        app.setCodeGenType(selectedCodeGenType.getValue());

        // 插入数据库
        boolean result = this.save(app);
        ThrowUtils.throwIf(!result, ErrorCode.OPERATION_ERROR);
        log.info("应用创建成功，ID: {}，类型: {}", app.getId(), selectedCodeGenType.getValue());
        return app.getId();
    }

    @Override
    public boolean removeById(Serializable id) {
        if (id == null) {
            return false;
        }
        long appId = Long.parseLong(id.toString());
        if (appId <= 0) {
            return false;
        }
        // 删除应用
        if (!super.removeById(id)) {
            ThrowUtils.throwForOperation("删除应用失败");
        }
        // 开启虚拟线程进行垃圾清理（删除对应的会话历史）
        Thread.startVirtualThread(() -> {
            try {
                chatHistoryService.removeByAppId(appId);
            } catch (Exception e) {
                log.error("failed to clear chat history, appId: {}", appId, e);
            }
        });
        return true;
    }

    @Override
    public String deployApp(Long appId, User loginUser) {
        // 参数校验
        validateParam(appId, loginUser);
        // 身份校验
        App app = Optional.ofNullable(this.getById(appId))
                .orElseThrow(() -> new BusinessException(ErrorCode.PARAMS_ERROR, "应用不存在"));
        if (!app.getUserId().equals(loginUser.getId())) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "无权限部署应用");
        }
        // 检查是否已有 deployKey
        String deployKey = app.getDeployKey();
        // 如果没有则生成部署 6 位 deployKey
        if (StrUtil.isBlank(deployKey)) {
            // 如果 deployKey 和其他用户的冲突，deployKey 有唯一键，插入数据库直接失败，这里不用校验是否重复了（实际重复概率约等于不可能）
            deployKey = RandomUtil.randomString(6);
        }
        // 获取应用生成类型，获取代码生成路径（应用访问路径）
        String codeGenType = app.getCodeGenType();
        String sourceDirName = StrUtil.format("{}_{}", codeGenType, appId);
        String sourceDirPath = AppConstant.CODE_OUTPUT_ROOT_DIR + File.separator + sourceDirName;
        File sourceDir = new File(sourceDirPath);
        // 检查已生成应用的路径是否存在
        if (!sourceDir.exists() || !FileUtil.isDirectory(sourceDir)) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "应用代码路径不存在，请先生成应用");
        }
        // 构建项目，将项目构建结果作为部署源
        sourceDir = BuilderExecutor.doBuild(
                Objects.requireNonNull(
                        CodeGenTypeEnum.getEnumByValue(codeGenType)
                ),
                sourceDirPath
        );
        // 复制文件到部署目录 todo 后续可能是上传到其他的服务器上
        String deployDirPath = AppConstant.CODE_DEPLOY_ROOT_DIR + File.separator + deployKey;
        try {
            FileUtil.copyContent(sourceDir, new File(deployDirPath), true);
        } catch (Exception e) {
            log.error("failed to deploy app, app: {}, userId: {}", app, loginUser.getId());
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "部署失败，请稍后再试");
        }
        // 将部署消息上传到数据库中
        app.setDeployKey(deployKey);
        app.setDeployedTime(LocalDateTime.now());
        boolean updateRes = this.updateById(app);
        ThrowUtils.throwIf(!updateRes, ErrorCode.OPERATION_ERROR, "更新应用部署信息失败");
        // 返回可访问的 URL 路径
        String appDeployUrl = StrUtil.format("{}/{}", AppConstant.CODE_DEPLOY_HOST, deployKey);
        // 异步执行截图并更新应用封面
        generateAppScreenshotAsync(appId, appDeployUrl);
        return appDeployUrl;
    }

    @Override
    public void generateAppScreenshotAsync(Long appId, String appDeployUrl) {
        Thread.startVirtualThread(() -> {
            String screenshotWebUrl = screenshotService.generateAndUploadScreenshot(appDeployUrl);
            App updateApp = new App();
            updateApp.setId(appId);
            updateApp.setCover(screenshotWebUrl);
            boolean updated = this.updateById(updateApp);
            ThrowUtils.throwIf(!updated, ErrorCode.OPERATION_ERROR, "更新应用封面字段失败");
        });
    }

    /**
     * 参数校验 - 2 param
     */
    private void validateParam(Long appId, User loginUser) {
        validateParam(appId, "override", loginUser);
    }

    @Override
    public Flux<ServerSentEvent<String>> chatToGenCode(Long appId, String message, User loginUser) {
        // 参数校验
        validateParam(appId, message, loginUser);
        // 用户只能给自己的应用生成代码
        App app = Optional.ofNullable(this.getById(appId))
                .orElseThrow(() -> new BusinessException(ErrorCode.PARAMS_ERROR, "应用不存在"));
        if (!app.getUserId().equals(loginUser.getId())) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "无权限生成代码");
        }
        // 调用 AI 前，先将用户消息添加到会话历史中
        chatHistoryService.addChatMessage(appId, message, ChatHistoryMessageTypeEnum.USER.getValue(), loginUser);
        String codeGenType = app.getCodeGenType();
        CodeGenTypeEnum codeGenTypeEnum = Optional.ofNullable(CodeGenTypeEnum.getEnumByValue(codeGenType))
                .orElseThrow(() -> new BusinessException(ErrorCode.PARAMS_ERROR, "代码生成类型不合法"));
        // 灰度开关：true 走 Python Agent 链路，false 走旧 Java AI 实现（行为不变）
        if (pythonAgentProperties.isEnabled()) {
            return pythonChatToGenCode(appId, message, loginUser, codeGenTypeEnum);
        }
        // 旧链路（行为与迁移前完全一致）
        Flux<String> contentFlux = aiCodeGeneratorFacade.generateAndSaveCodeStream(message, codeGenTypeEnum, appId);
        Flux<String> display = streamHandlerExecutor.doHandle(contentFlux, chatHistoryService, appId, loginUser, codeGenTypeEnum);
        return display.map(this::dataSse).concatWith(Mono.just(doneSse()));
    }

    /**
     * Python Agent 链路：主通道事件流 → 浏览器显示 + 回调终端信号（T15/T17/T18）
     * 主通道结束后进入「等待回调」阶段（§1.5），done 由回调触发；超时兜底 business-error
     *
     * @param appId          应用 id
     * @param message        用户提示词
     * @param loginUser      当前登录用户
     * @param codeGenTypeEnum 代码生成类型
     * @return 浏览器 SSE 流（含终端事件）
     */
    private Flux<ServerSentEvent<String>> pythonChatToGenCode(Long appId, String message, User loginUser,
                                                              CodeGenTypeEnum codeGenTypeEnum) {
        // 1. 生成 runId 并注册浏览器连接终端（回调到达 / 超时通过该终端发 done / business-error）
        String runId = UUID.randomUUID().toString();
        String workspacePath = StrUtil.format("{}/{}_{}", AppConstant.CODE_OUTPUT_ROOT_DIR, codeGenTypeEnum.getValue(), appId);
        runIdSinkRegistry.register(runId, appId, codeGenTypeEnum, workspacePath, loginUser);
        // 2. 构造主通道请求（§1.2：threadId 固定 app:{appId}，history 最近 20 条 bootstrap）
        PythonAgentRequest request = new PythonAgentRequest();
        request.setAppId(appId);
        request.setUserId(loginUser.getId());
        request.setMessage(message);
        request.setCodeGenType(codeGenTypeEnum.getValue());
        request.setRunId(runId);
        request.setThreadId("app:" + appId);
        request.setWorkspacePath(workspacePath);
        request.setHistory(loadRecentHistory(appId));
        // 3. 调用 Python 主通道；错误事件触发 failed 终端（幂等）
        Flux<PythonAgentClient.SseEvent> pythonSse = pythonAgentClient.stream(request)
                .doOnNext(event -> handlePythonErrorEvent(runId, appId, loginUser, event));
        // 4. 事件分流 → 浏览器显示文本（复用现有 handler，§1.6）
        Flux<String> display = pythonAgentSseAdapter.adapt(pythonSse, codeGenTypeEnum, chatHistoryService, appId, loginUser);
        // 5. 显示文本包 {"d":...}；主通道结束后等待回调终端信号，超时用兜底 business-error
        Mono<ServerSentEvent<String>> terminal = runIdSinkRegistry.awaitTerminal(
                runId, pythonAgentProperties.getCallbackTimeoutMs(), () -> {
                    // 幂等：超时仅处理一次
                    if (runIdSinkRegistry.tryMarkProcessed(runId)) {
                        chatHistoryService.addChatMessage(appId, "生成超时，请重试",
                                ChatHistoryMessageTypeEnum.AI.getValue(), loginUser);
                    }
                    return businessErrorSse(ErrorCode.OPERATION_ERROR, "生成超时，请重试");
                });
        return display.map(this::dataSse).concatWith(terminal);
    }

    /**
     * Python 主通道错误事件处理（§1.3 event:error → 浏览器 business-error + 幂等失败历史）
     *
     * @param runId     runId
     * @param appId     应用 id
     * @param loginUser 当前登录用户
     * @param event     SSE 事件
     */
    private void handlePythonErrorEvent(String runId, Long appId, User loginUser, PythonAgentClient.SseEvent event) {
        if (!"error".equals(event.event())) {
            return;
        }
        if (!runIdSinkRegistry.tryMarkProcessed(runId)) {
            return;
        }
        String message = extractErrorMessage(event.data());
        log.error("Python Agent 返回错误事件，runId: {}, message: {}", runId, message);
        chatHistoryService.addChatMessage(appId, "生成失败：" + message,
                ChatHistoryMessageTypeEnum.AI.getValue(), loginUser);
        runIdSinkRegistry.complete(runId, businessErrorSse(ErrorCode.OPERATION_ERROR, message));
    }

    /**
     * 从错误事件 data（{"message":"..."}）中提取错误消息
     *
     * @param data 错误事件载荷
     * @return 错误消息
     */
    private String extractErrorMessage(String data) {
        if (StrUtil.isBlank(data)) {
            return "未知错误";
        }
        try {
            return JSONUtil.parseObj(data).getStr("message", "未知错误");
        } catch (Exception e) {
            return data;
        }
    }

    /**
     * 加载最近 20 条对话历史（§1.2 history，role user/assistant，时间正序）
     *
     * @param appId 应用 id
     * @return 历史条目列表
     */
    private List<PythonAgentRequest.HistoryItem> loadRecentHistory(Long appId) {
        QueryWrapper queryWrapper = QueryWrapper.create()
                .eq(ChatHistory::getAppId, appId)
                .in(ChatHistory::getMessageType,
                        ChatHistoryMessageTypeEnum.USER.getValue(),
                        ChatHistoryMessageTypeEnum.AI.getValue())
                .orderBy(ChatHistory::getCreateTime, false)
                .limit(0, 20);
        List<ChatHistory> historyList = chatHistoryService.list(queryWrapper);
        List<PythonAgentRequest.HistoryItem> items = new ArrayList<>();
        // 倒序取回正序（老的在前，新的在后）
        for (int i = historyList.size() - 1; i >= 0; i--) {
            ChatHistory history = historyList.get(i);
            if (StrUtil.isBlank(history.getMessage())) {
                continue;
            }
            PythonAgentRequest.HistoryItem item = new PythonAgentRequest.HistoryItem();
            item.setRole(ChatHistoryMessageTypeEnum.USER.getValue().equals(history.getMessageType()) ? "user" : "assistant");
            item.setContent(history.getMessage());
            items.add(item);
        }
        return items;
    }

    /**
     * 浏览器文本事件：data: {"d":"<显示文本>"}（§1.6）
     *
     * @param chunk 显示文本
     * @return SSE 事件
     */
    private ServerSentEvent<String> dataSse(String chunk) {
        return ServerSentEvent.<String>builder()
                .data(JSONUtil.toJsonStr(Map.of("d", chunk)))
                .build();
    }

    /**
     * 完成事件：event: done（构建完成后发出）
     *
     * @return SSE 事件
     */
    private ServerSentEvent<String> doneSse() {
        return ServerSentEvent.<String>builder().event("done").build();
    }

    /**
     * 业务错误事件：event: business-error + data: {"error":true,"code":...,"message":"..."}
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
     * 参数校验 - 3 param
     */
    private void validateParam(Long appId, String message, User loginUser) {
        if (appId == null || StrUtil.isBlank(message) || loginUser == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "所有参数均不能为空");
        }
        if (appId <= 0) {
            log.error("the given appId is illegal, appId: {}", appId);
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "应用 id 值不合法");
        }
        if (loginUser.getId() == null || loginUser.getId() <= 0) {
            log.error("error user, the given user's id is illegal, loginUser: {}, userId: {}", loginUser, loginUser.getId());
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "用户 id 值不合法");
        }
    }

    /**
     * 返回 AI 响应流之前，保存对话历史 - 弃用，现已使用处理器处理
     */
    @Deprecated
    private Flux<String> saveAiResponseBeforeReturn(Flux<String> contentFlux, Long appId, User loginUser) {
        // 字符串拼接器，用于当流式返回所有的代码之后，再保存代码
        StringBuilder aiResponseBuilder = new StringBuilder();
        return contentFlux
                // 实时收集代码片段
                .doOnNext(aiResponseBuilder::append)
                .doOnComplete(
                        () -> chatHistoryService.addChatMessage(appId, aiResponseBuilder.toString(),
                                ChatHistoryMessageTypeEnum.AI.getValue(), loginUser)
                )
                .doOnError(throwable -> {
                    // 如果 AI 回复失败，也要将异常消息保存到数据库中
                    String errorMessage = StrUtil.format("AI 回复失败 {} ", throwable.getMessage());
                    chatHistoryService.addChatMessage(appId, errorMessage,
                            ChatHistoryMessageTypeEnum.AI.getValue(), loginUser);
                });
    }

    @Override
    public AppVO getAppVO(App app) {
        if (app == null) {
            return null;
        }
        AppVO appVO = new AppVO();
        BeanUtil.copyProperties(app, appVO);
        // 关联查询用户信息
        Long userId = app.getUserId();
        if (userId != null) {
            User user = userService.getById(userId);
            UserVO userVO = userService.getUserVO(user);
            appVO.setUser(userVO);
        }
        return appVO;
    }

    @Override
    public List<AppVO> getAppVOList(List<App> appList) {
        if (CollUtil.isEmpty(appList)) {
            return new ArrayList<>();
        }
        // 批量获取用户信息，避免 N+1 查询问题
        Set<Long> userIds = appList.stream()
                .map(App::getUserId)
                .collect(Collectors.toSet());

        Map<Long, UserVO> userVOMap = userService.listByIds(userIds).stream()
                .collect(Collectors.toMap(User::getId, userService::getUserVO));

        return appList.stream().map(app -> {
            AppVO appVO = getAppVO(app);
            UserVO userVO = userVOMap.get(app.getUserId());
            appVO.setUser(userVO);
            return appVO;
        }).collect(Collectors.toList());
    }

    @Override
    public QueryWrapper getQueryWrapper(AppQueryRequest appQueryRequest) {
        if (appQueryRequest == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "请求参数为空");
        }

        Long id = appQueryRequest.getId();
        String appName = appQueryRequest.getAppName();
        String cover = appQueryRequest.getCover();
        String initPrompt = appQueryRequest.getInitPrompt();
        String codeGenType = appQueryRequest.getCodeGenType();
        String deployKey = appQueryRequest.getDeployKey();
        Integer priority = appQueryRequest.getPriority();
        Long userId = appQueryRequest.getUserId();
        String sortField = appQueryRequest.getSortField();
        String sortOrder = appQueryRequest.getSortOrder();

        return QueryWrapper.create()
                .eq("id", id)
                .like("appName", appName)
                .like("cover", cover)
                .like("initPrompt", initPrompt)
                .eq("codeGenType", codeGenType)
                .eq("deployKey", deployKey)
                .eq("priority", priority)
                .eq("userId", userId)
                .orderBy(sortField, "ascend".equals(sortOrder));
    }
}
