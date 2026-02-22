package com.zdan.paimengaicodemother.service;

import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.core.service.IService;
import com.zdan.paimengaicodemother.model.dto.app.AppQueryRequest;
import com.zdan.paimengaicodemother.model.dto.chathistory.ChatHistoryQueryRequest;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.vo.AppVO;
import reactor.core.publisher.Flux;

import java.util.List;

/**
 * 应用 服务层。
 *
 * @author LXH
 */
public interface AppService extends IService<App> {

    /**
     * 部署应用
     *
     * @param appId     应用 id
     * @param loginUser 当前登录用户
     * @return 应用访问 url
     */
    String deployApp(Long appId, User loginUser);

    /**
     * 异步执行应用截图和更新封面
     *
     * @param appId        应用 ID
     * @param appDeployUrl 应用的部署 url
     */
    void generateAppScreenshotAsync(Long appId, String appDeployUrl);

    /**
     * 通过对话生成应用代码
     *
     * @param appId     应用 id
     * @param message   提示词
     * @param loginUser 当前登录用户
     */
    Flux<String> chatToGenCode(Long appId, String message, User loginUser);

    /**
     * 获取应用封装类
     *
     * @param app 应用实体
     */
    AppVO getAppVO(App app);

    /**
     * 获取应用封装类列表
     *
     * @param appList 应用实体列表
     */
    List<AppVO> getAppVOList(List<App> appList);

    /**
     * 获取查询条件包装
     *
     * @param appQueryRequest 应用查询请求
     */
    QueryWrapper getQueryWrapper(AppQueryRequest appQueryRequest);
}
