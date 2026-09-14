package com.zdan.paimengaicodebackend.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.mybatisflex.core.paginate.Page;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodebackend.constant.UserConstant;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.exception.ThrowUtils;
import com.zdan.paimengaicodebackend.mapper.ChatHistoryMapper;
import com.zdan.paimengaicodebackend.model.dto.chathistory.ChatHistoryQueryRequest;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.ChatHistory;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.model.enums.ChatHistoryMessageTypeEnum;
import com.zdan.paimengaicodebackend.service.AppService;
import com.zdan.paimengaicodebackend.service.ChatHistoryService;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;


@Slf4j
@Service
public class ChatHistoryServiceImpl extends ServiceImpl<ChatHistoryMapper, ChatHistory> implements ChatHistoryService {

    private final AppService appService;

    public ChatHistoryServiceImpl(@Lazy AppService appService) {
        this.appService = appService;
    }

    @Override
    public int loadChatHistoryToMemory(Long appId, MessageWindowChatMemory chatMemory, int maxCount) {
        try {

            QueryWrapper queryWrapper = QueryWrapper.create()
                    .eq(ChatHistory::getAppId, appId)
                    .orderBy(ChatHistory::getCreateTime, false)
                    .limit(1, maxCount);
            List<ChatHistory> historyList = this.list(queryWrapper);
            if (CollUtil.isEmpty(historyList)) {
                return 0;
            }


            historyList = historyList.reversed();


            int loadedCount = 0;

            chatMemory.clear();
            for (ChatHistory history : historyList) {
                if (ChatHistoryMessageTypeEnum.USER.getValue().equals(history.getMessageType())) {
                    chatMemory.add(UserMessage.from(history.getMessage()));
                    loadedCount++;
                } else if (ChatHistoryMessageTypeEnum.AI.getValue().equals(history.getMessageType())) {
                    chatMemory.add(AiMessage.from(history.getMessage()));
                    loadedCount++;
                }
            }
            log.info("{} chatHistory were successfully loaded for appId: {}", loadedCount, appId);
            return loadedCount;
        } catch (Exception e) {
            log.error("failed to load chatHistory to chatMemory，appId: {}, error: {}", appId, e.getMessage(), e);

            return 0;
        }
    }

    @Override
    public Page<ChatHistory> listAppChatHistoryByPage(Long appId, int pageSize,
                                                      LocalDateTime lastCreateTime,
                                                      User loginUser) {

        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "应用ID不能为空");
        ThrowUtils.throwIf(pageSize <= 0 || pageSize > 50, ErrorCode.PARAMS_ERROR, "页面大小必须在1-50之间");
        ThrowUtils.throwIf(loginUser == null, ErrorCode.NOT_LOGIN_ERROR);


        App app = appService.getById(appId);
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR, "应用不存在");
        boolean isAdmin = UserConstant.ADMIN_ROLE.equals(loginUser.getUserRole());
        boolean isCreator = app.getUserId().equals(loginUser.getId());
        ThrowUtils.throwIf(!isAdmin && !isCreator, ErrorCode.NO_AUTH_ERROR, "无权查看该应用的对话历史");


        ChatHistoryQueryRequest queryRequest = new ChatHistoryQueryRequest();
        queryRequest.setAppId(appId);
        queryRequest.setLastCreateTime(lastCreateTime);
        QueryWrapper queryWrapper = this.getQueryWrapper(queryRequest);


        return this.page(Page.of(1, pageSize), queryWrapper);
    }

    @Override
    public QueryWrapper getQueryWrapper(ChatHistoryQueryRequest chatHistoryQueryRequest) {
        QueryWrapper queryWrapper = QueryWrapper.create();
        if (chatHistoryQueryRequest == null) {
            return queryWrapper;
        }

        Long id = chatHistoryQueryRequest.getId();
        String message = chatHistoryQueryRequest.getMessage();
        String messageType = chatHistoryQueryRequest.getMessageType();
        Long appId = chatHistoryQueryRequest.getAppId();
        Long userId = chatHistoryQueryRequest.getUserId();
        LocalDateTime lastCreateTime = chatHistoryQueryRequest.getLastCreateTime();
        String sortField = chatHistoryQueryRequest.getSortField();
        String sortOrder = chatHistoryQueryRequest.getSortOrder();


        queryWrapper.eq("id", id)
                .like("message", message)
                .eq("messageType", messageType)
                .eq("appId", appId)
                .eq("userId", userId);


        if (lastCreateTime != null) {
            queryWrapper.lt("createTime", lastCreateTime);
        }


        if (StrUtil.isNotBlank(sortField)) {
            queryWrapper.orderBy(sortField, "ascend".equals(sortOrder));
        } else {

            queryWrapper.orderBy("createTime", false);
        }

        return queryWrapper;
    }

    @Override
    public void addChatMessage(Long appId, String message, String messageType, User user) {
        validateParam(appId, message, messageType, user);

        ChatHistory chatHistory = new ChatHistory();
        chatHistory.setMessage(message);
        chatHistory.setMessageType(messageType);
        chatHistory.setAppId(appId);
        chatHistory.setUserId(user.getId());

        boolean save = this.save(chatHistory);
        ThrowUtils.throwIf(!save, ErrorCode.OPERATION_ERROR, "添加会话消息失败");
    }

    @Override
    public void removeByAppId(Long appId) {
        this.mapper.deleteByQuery(QueryWrapper.create()
                .eq(ChatHistory::getAppId, appId));
    }


    private void validateParam(Long appId, String message, String messageType, User user) {

        if (appId == null || appId <= 0) {
            ThrowUtils.throwForParam("应用 id 不能为空");
        }

        if (StrUtil.isBlank(message)) {
            ThrowUtils.throwForParam("消息不能为空");
        }

        if (StrUtil.isBlank(messageType)) {
            ThrowUtils.throwForParam("消息类型不能为空");
        } else if (ChatHistoryMessageTypeEnum.getEnumByValue(messageType) == null) {
            ThrowUtils.throwForParam("消息类型非法");
        }

        if (user == null) {
            ThrowUtils.throwForNotLogin("请先完成登录");
        } else if (user.getId() == null || user.getId() <= 0) {
            log.error("the given user is invalid: {}", user);
            ThrowUtils.throwForOperation("登录状态异常");
        }
    }
}
