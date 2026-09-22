package com.zdan.paimengaicodebackend.controller;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.util.StrUtil;
import com.mybatisflex.core.paginate.Page;
import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.ai.agent.AgentJwtProperties;
import com.zdan.paimengaicodebackend.ai.agent.AgentJwtService;
import com.zdan.paimengaicodebackend.ai.agent.AgentProperties;
import com.zdan.paimengaicodebackend.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodebackend.annotation.AuthCheck;
import com.zdan.paimengaicodebackend.common.BaseResponse;
import com.zdan.paimengaicodebackend.common.DeleteRequest;
import com.zdan.paimengaicodebackend.common.ResultUtils;
import com.zdan.paimengaicodebackend.constant.AppConstant;
import com.zdan.paimengaicodebackend.constant.UserConstant;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.exception.ThrowUtils;
import com.zdan.paimengaicodebackend.model.dto.app.*;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.model.vo.AgentTokenVO;
import com.zdan.paimengaicodebackend.model.vo.AppVO;
import com.zdan.paimengaicodebackend.service.AppService;
import com.zdan.paimengaicodebackend.service.ProjectDownloadService;
import com.zdan.paimengaicodebackend.service.UserService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.File;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import lombok.extern.slf4j.Slf4j;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.web.bind.annotation.*;

@Slf4j
@RestController
@RequestMapping("/app")
public class AppController {

    private static final String ACTIVE_LIFECYCLE_STATUS = "ACTIVE";

    private final AppService appService;
    private final UserService userService;
    private final ProjectDownloadService projectDownloadService;
    private final AgentProperties agentProperties;
    private final AgentJwtProperties agentJwtProperties;
    private final AgentJwtService agentJwtService;

    public AppController(
        AppService appService,
        UserService userService,
        ProjectDownloadService projectDownloadService,
        AgentProperties agentProperties,
        AgentJwtProperties agentJwtProperties,
        AgentJwtService agentJwtService
    ) {
        this.appService = appService;
        this.userService = userService;
        this.projectDownloadService = projectDownloadService;
        this.agentProperties = agentProperties;
        this.agentJwtProperties = agentJwtProperties;
        this.agentJwtService = agentJwtService;
    }

    @GetMapping("/download/{appId}")
    public void downloadAppCode(
        @PathVariable Long appId,
        HttpServletRequest request,
        HttpServletResponse response
    ) {
        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "应用ID无效");

        App app = requireActiveApp(appId);

        User loginUser = userService.getLoginUser(request);
        if (!app.getUserId().equals(loginUser.getId())) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "无权限下载该应用代码");
        }

        String codeGenType = app.getCodeGenType();
        String sourceDirName = codeGenType + "_" + appId;
        String sourceDirPath = AppConstant.CODE_OUTPUT_ROOT_DIR + File.separator + sourceDirName;

        File sourceDir = new File(sourceDirPath);
        ThrowUtils.throwIf(
            !sourceDir.exists() || !sourceDir.isDirectory(),
            ErrorCode.NOT_FOUND_ERROR,
            "应用代码不存在，请先生成代码"
        );

        String downloadFileName = String.valueOf(appId);

        projectDownloadService.downloadProjectAsZip(sourceDirPath, downloadFileName, response);
    }

    @PostMapping("/deploy")
    public BaseResponse<String> deployApp(
        @RequestBody AppDeployRequest appDeployRequest,
        HttpServletRequest request
    ) {
        ThrowUtils.throwIf(appDeployRequest == null, ErrorCode.PARAMS_ERROR);
        Long appId = appDeployRequest.getAppId();
        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "应用 ID 不能为空");

        User loginUser = userService.getLoginUser(request);

        String deployUrl = appService.deployApp(appId, loginUser);
        return ResultUtils.success(deployUrl);
    }

    @GetMapping("/agent/token")
    public BaseResponse<AgentTokenVO> getAgentToken(
        @RequestParam Long appId,
        HttpServletRequest request
    ) {
        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "应用 id 错误");

        User loginUser = userService.getLoginUser(request);
        App app = requireActiveApp(appId);
        if (!app.getUserId().equals(loginUser.getId())) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "无权限生成代码");
        }

        if (!agentProperties.isEnabled()) {
            throw new BusinessException(
                ErrorCode.AGENT_DISABLED,
                "代码生成新链路未开启（ts-agent.enabled=false），请联系管理员开启"
            );
        }

        String codeGenType = Optional.ofNullable(
            CodeGenTypeEnum.getEnumByValue(app.getCodeGenType())
        )
            .orElseThrow(() -> new BusinessException(ErrorCode.PARAMS_ERROR, "代码生成类型不合法"))
            .getValue();
        String workspacePath = StrUtil.format(
            "{}/{}_{}",
            AppConstant.CODE_OUTPUT_ROOT_DIR,
            codeGenType,
            appId
        );

        AgentTokenVO agentTokenVO = new AgentTokenVO();
        agentTokenVO.setToken(
            agentJwtService.issueToken(loginUser.getId(), appId, workspacePath)
        );
        agentTokenVO.setWorkspacePath(workspacePath);
        agentTokenVO.setExpiresAt(
            System.currentTimeMillis() + agentJwtProperties.getTtlMinutes() * 60 * 1000
        );
        return ResultUtils.success(agentTokenVO);
    }

    @PostMapping("/add")
    public BaseResponse<Long> addApp(
        @RequestBody AppAddRequest appAddRequest,
        HttpServletRequest request
    ) {
        ThrowUtils.throwIf(appAddRequest == null, ErrorCode.PARAMS_ERROR);

        User loginUser = userService.getLoginUser(request);

        Long appId = appService.createApp(appAddRequest, loginUser);
        return ResultUtils.success(appId);
    }

    @PostMapping("/update")
    public BaseResponse<Boolean> updateApp(
        @RequestBody AppUpdateRequest appUpdateRequest,
        HttpServletRequest request
    ) {
        if (appUpdateRequest == null || appUpdateRequest.getId() == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        User loginUser = userService.getLoginUser(request);
        long id = appUpdateRequest.getId();

        App oldApp = requireActiveApp(id);

        if (!oldApp.getUserId().equals(loginUser.getId())) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR);
        }
        App app = new App();
        app.setId(id);
        app.setAppName(appUpdateRequest.getAppName());

        app.setEditTime(LocalDateTime.now());
        boolean result = appService.updateById(app);
        ThrowUtils.throwIf(!result, ErrorCode.OPERATION_ERROR);
        return ResultUtils.success(true);
    }

    @PostMapping("/delete")
    public BaseResponse<Boolean> deleteApp(
        @RequestBody DeleteRequest deleteRequest,
        HttpServletRequest request
    ) {
        if (deleteRequest == null || deleteRequest.getId() <= 0) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        User loginUser = userService.getLoginUser(request);
        long id = deleteRequest.getId();

        App oldApp = requireActiveApp(id);

        if (
            !oldApp.getUserId().equals(loginUser.getId()) &&
            !UserConstant.ADMIN_ROLE.equals(loginUser.getUserRole())
        ) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR);
        }
        boolean result = appService.removeById(id);
        return ResultUtils.success(result);
    }

    @GetMapping("/get/vo")
    public BaseResponse<AppVO> getAppVOById(long id) {
        ThrowUtils.throwIf(id <= 0, ErrorCode.PARAMS_ERROR);

        App app = requireActiveApp(id);

        return ResultUtils.success(appService.getAppVO(app));
    }

    @PostMapping("/my/list/page/vo")
    public BaseResponse<Page<AppVO>> listMyAppVOByPage(
        @RequestBody AppQueryRequest appQueryRequest,
        HttpServletRequest request
    ) {
        ThrowUtils.throwIf(appQueryRequest == null, ErrorCode.PARAMS_ERROR);
        User loginUser = userService.getLoginUser(request);

        long pageSize = appQueryRequest.getPageSize();
        ThrowUtils.throwIf(pageSize > 20, ErrorCode.PARAMS_ERROR, "每页最多查询 20 个应用");
        long pageNum = appQueryRequest.getPageNum();

        appQueryRequest.setUserId(loginUser.getId());
        QueryWrapper queryWrapper = appService.getQueryWrapper(appQueryRequest);
        Page<App> appPage = appService.page(Page.of(pageNum, pageSize), queryWrapper);

        Page<AppVO> appVOPage = new Page<>(pageNum, pageSize, appPage.getTotalRow());
        List<AppVO> appVOList = appService.getAppVOList(appPage.getRecords());
        appVOPage.setRecords(appVOList);

        return ResultUtils.success(appVOPage);
    }

    @PostMapping("/good/list/page/vo")
    @Cacheable(
        value = "good_app_page",
        key = "T(com.zdan.paimengaicodebackend.utils.CacheKeyUtils).generateKey(#appQueryRequest)",
        condition = "#appQueryRequest.pageNum <= 10"
    )
    public BaseResponse<Page<AppVO>> listGoodAppVOByPage(
        @RequestBody AppQueryRequest appQueryRequest
    ) {
        ThrowUtils.throwIf(appQueryRequest == null, ErrorCode.PARAMS_ERROR);

        long pageSize = appQueryRequest.getPageSize();
        ThrowUtils.throwIf(pageSize > 20, ErrorCode.PARAMS_ERROR, "每页最多查询 20 个应用");
        long pageNum = appQueryRequest.getPageNum();

        appQueryRequest.setPriority(AppConstant.GOOD_APP_PRIORITY);
        QueryWrapper queryWrapper = appService.getQueryWrapper(appQueryRequest);

        Page<App> appPage = appService.page(Page.of(pageNum, pageSize), queryWrapper);

        Page<AppVO> appVOPage = new Page<>(pageNum, pageSize, appPage.getTotalRow());
        List<AppVO> appVOList = appService.getAppVOList(appPage.getRecords());
        appVOPage.setRecords(appVOList);

        return ResultUtils.success(appVOPage);
    }

    @PostMapping("/admin/delete")
    @AuthCheck(mustRole = UserConstant.ADMIN_ROLE)
    public BaseResponse<Boolean> deleteAppByAdmin(@RequestBody DeleteRequest deleteRequest) {
        if (deleteRequest == null || deleteRequest.getId() <= 0) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        long id = deleteRequest.getId();

        requireActiveApp(id);
        boolean result = appService.removeById(id);
        return ResultUtils.success(result);
    }

    @PostMapping("/admin/update")
    @AuthCheck(mustRole = UserConstant.ADMIN_ROLE)
    public BaseResponse<Boolean> updateAppByAdmin(
        @RequestBody AppAdminUpdateRequest appAdminUpdateRequest
    ) {
        if (appAdminUpdateRequest == null || appAdminUpdateRequest.getId() == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        long id = appAdminUpdateRequest.getId();

        requireActiveApp(id);
        App app = new App();
        BeanUtil.copyProperties(appAdminUpdateRequest, app);

        app.setEditTime(LocalDateTime.now());
        boolean result = appService.updateById(app);
        ThrowUtils.throwIf(!result, ErrorCode.OPERATION_ERROR);
        return ResultUtils.success(true);
    }

    @PostMapping("/admin/list/page/vo")
    @AuthCheck(mustRole = UserConstant.ADMIN_ROLE)
    public BaseResponse<Page<AppVO>> listAppVOByPageByAdmin(
        @RequestBody AppQueryRequest appQueryRequest
    ) {
        ThrowUtils.throwIf(appQueryRequest == null, ErrorCode.PARAMS_ERROR);
        long pageNum = appQueryRequest.getPageNum();
        long pageSize = appQueryRequest.getPageSize();
        QueryWrapper queryWrapper = appService.getQueryWrapper(appQueryRequest);
        Page<App> appPage = appService.page(Page.of(pageNum, pageSize), queryWrapper);

        Page<AppVO> appVOPage = new Page<>(pageNum, pageSize, appPage.getTotalRow());
        List<AppVO> appVOList = appService.getAppVOList(appPage.getRecords());
        appVOPage.setRecords(appVOList);

        return ResultUtils.success(appVOPage);
    }

    @GetMapping("/admin/get/vo")
    @AuthCheck(mustRole = UserConstant.ADMIN_ROLE)
    public BaseResponse<AppVO> getAppVOByIdByAdmin(long id) {
        ThrowUtils.throwIf(id <= 0, ErrorCode.PARAMS_ERROR);

        App app = requireActiveApp(id);

        return ResultUtils.success(appService.getAppVO(app));
    }

    private App requireActiveApp(long appId) {
        App app = appService.getById(appId);
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR, "应用不存在");
        ThrowUtils.throwIf(
            !ACTIVE_LIFECYCLE_STATUS.equals(app.getLifecycleStatus()),
            ErrorCode.NOT_FOUND_ERROR,
            "应用不存在"
        );
        return app;
    }
}
