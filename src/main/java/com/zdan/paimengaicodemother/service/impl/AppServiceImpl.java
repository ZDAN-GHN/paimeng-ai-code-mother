package com.zdan.paimengaicodemother.service.impl;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.RandomUtil;
import cn.hutool.core.util.StrUtil;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodemother.constant.AppConstant;
import com.zdan.paimengaicodemother.core.AiCodeGeneratorFacade;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.model.dto.app.AppQueryRequest;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.mapper.AppMapper;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.model.vo.AppVO;
import com.zdan.paimengaicodemother.model.vo.UserVO;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.UserService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

import java.io.File;
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
    private final AiCodeGeneratorFacade aiCodeGeneratorFacade;

    public AppServiceImpl(UserService userService,
                          AiCodeGeneratorFacade aiCodeGeneratorFacade) {
        this.userService = userService;
        this.aiCodeGeneratorFacade = aiCodeGeneratorFacade;
    }

    @Override
    public String deployApp(Long appId, User loginUser) {
        // 参数校验
        validateParam(appId, loginUser);
        // 身份校验
        App app = Optional.ofNullable(this.getById(appId))
                .orElseThrow(() -> new BusinessException(ErrorCode.PARAMS_ERROR, "应用不存在"));
        if (!app.getUserId().equals(loginUser.getId())) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "无权限生成代码");
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
        return StrUtil.format("{}/{}", AppConstant.CODE_DEPLOY_HOST, deployKey);
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

        return QueryWrapper.<App>create()
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

    @Override
    public Flux<String> chatToGenCode(Long appId, String message, User loginUser) {
        // 参数校验
        validateParam(appId, message, loginUser);
        // 用户只能给自己的应用生成代码
        App app = Optional.ofNullable(this.getById(appId))
                .orElseThrow(() -> new BusinessException(ErrorCode.PARAMS_ERROR, "应用不存在"));
        if (!app.getUserId().equals(loginUser.getId())) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "无权限生成代码");
        }
        // 调用代码生成门面类
        String codeGenType = app.getCodeGenType();
        CodeGenTypeEnum codeGenTypeEnum = Optional.ofNullable(CodeGenTypeEnum.getEnumByValue(codeGenType))
                .orElseThrow(() -> new BusinessException(ErrorCode.PARAMS_ERROR, "代码生成类型不合法"));
        Flux<String> codeFlux = aiCodeGeneratorFacade.generateAndSaveCodeStream(message, codeGenTypeEnum, appId);
        // 返回响应式对象
        return codeFlux;
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
}
