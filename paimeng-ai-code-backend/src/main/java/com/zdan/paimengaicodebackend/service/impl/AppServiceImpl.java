package com.zdan.paimengaicodebackend.service.impl;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.RandomUtil;
import cn.hutool.core.util.StrUtil;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodebackend.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodebackend.constant.AppConstant;
import com.zdan.paimengaicodebackend.core.builder.BuilderExecutor;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.exception.ThrowUtils;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.model.dto.app.AppAddRequest;
import com.zdan.paimengaicodebackend.model.dto.app.AppQueryRequest;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.ChatHistory;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.model.enums.ChatHistoryMessageTypeEnum;
import com.zdan.paimengaicodebackend.model.vo.AppVO;
import com.zdan.paimengaicodebackend.model.vo.UserVO;
import com.zdan.paimengaicodebackend.service.AppService;
import com.zdan.paimengaicodebackend.service.ChatHistoryService;
import com.zdan.paimengaicodebackend.service.ScreenshotService;
import com.zdan.paimengaicodebackend.service.UserService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.File;
import java.io.Serializable;
import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;


@Slf4j
@Service
public class AppServiceImpl extends ServiceImpl<AppMapper, App> implements AppService {

    private final UserService userService;
    private final ChatHistoryService chatHistoryService;
    private final ScreenshotService screenshotService;

    public AppServiceImpl(UserService userService,
                          ChatHistoryService chatHistoryService,
                          ScreenshotService screenshotService) {
        this.userService = userService;
        this.chatHistoryService = chatHistoryService;
        this.screenshotService = screenshotService;
    }

    @Override
    public Long createApp(AppAddRequest appAddRequest, User loginUser) {

        String initPrompt = appAddRequest.getInitPrompt();
        ThrowUtils.throwIf(StrUtil.isBlank(initPrompt), ErrorCode.PARAMS_ERROR, "初始化prompt不能为空");


        App app = new App();
        BeanUtil.copyProperties(appAddRequest, app);
        app.setUserId(loginUser.getId());


        app.setAppName(initPrompt.substring(0, Math.min(initPrompt.length(), 12)));






        CodeGenTypeEnum selectedCodeGenType = CodeGenTypeEnum.HTML;
        app.setCodeGenType(selectedCodeGenType.getValue());


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

        if (!super.removeById(id)) {
            ThrowUtils.throwForOperation("删除应用失败");
        }

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

        validateParam(appId, loginUser);

        App app = Optional.ofNullable(this.getById(appId))
                .orElseThrow(() -> new BusinessException(ErrorCode.PARAMS_ERROR, "应用不存在"));
        if (!app.getUserId().equals(loginUser.getId())) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "无权限部署应用");
        }

        String deployKey = app.getDeployKey();

        if (StrUtil.isBlank(deployKey)) {

            deployKey = RandomUtil.randomString(6);
        }

        String codeGenType = app.getCodeGenType();
        String sourceDirName = StrUtil.format("{}_{}", codeGenType, appId);
        String sourceDirPath = AppConstant.CODE_OUTPUT_ROOT_DIR + File.separator + sourceDirName;
        File sourceDir = new File(sourceDirPath);

        if (!sourceDir.exists() || !FileUtil.isDirectory(sourceDir)) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "应用代码路径不存在，请先生成应用");
        }

        sourceDir = BuilderExecutor.doBuild(
                Objects.requireNonNull(
                        CodeGenTypeEnum.getEnumByValue(codeGenType)
                ),
                sourceDirPath
        );

        String deployDirPath = AppConstant.CODE_DEPLOY_ROOT_DIR + File.separator + deployKey;
        try {
            FileUtil.copyContent(sourceDir, new File(deployDirPath), true);
        } catch (Exception e) {
            log.error("failed to deploy app, app: {}, userId: {}", app, loginUser.getId());
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "部署失败，请稍后再试");
        }

        app.setDeployKey(deployKey);
        app.setDeployedTime(LocalDateTime.now());
        boolean updateRes = this.updateById(app);
        ThrowUtils.throwIf(!updateRes, ErrorCode.OPERATION_ERROR, "更新应用部署信息失败");

        String appDeployUrl = StrUtil.format("{}/{}", AppConstant.CODE_DEPLOY_HOST, deployKey);

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


    private void validateParam(Long appId, User loginUser) {
        validateParam(appId, "override", loginUser);
    }


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

    @Override
    public AppVO getAppVO(App app) {
        if (app == null) {
            return null;
        }
        AppVO appVO = new AppVO();
        BeanUtil.copyProperties(app, appVO);

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
