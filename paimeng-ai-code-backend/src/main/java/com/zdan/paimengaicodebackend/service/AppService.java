package com.zdan.paimengaicodebackend.service;

import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.core.service.IService;
import com.zdan.paimengaicodebackend.model.dto.app.AppAddRequest;
import com.zdan.paimengaicodebackend.model.dto.app.AppQueryRequest;
import com.zdan.paimengaicodebackend.model.dto.chathistory.ChatHistoryQueryRequest;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.model.vo.AppVO;
import java.util.List;

public interface AppService extends IService<App> {
    Long createApp(AppAddRequest appAddRequest, User loginUser);

    String deployApp(Long appId, User loginUser);

    void generateAppScreenshotAsync(Long appId, String appDeployUrl);

    AppVO getAppVO(App app);

    List<AppVO> getAppVOList(List<App> appList);

    QueryWrapper getQueryWrapper(AppQueryRequest appQueryRequest);
}
