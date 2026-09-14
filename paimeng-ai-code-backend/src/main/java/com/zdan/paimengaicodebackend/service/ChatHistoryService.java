package com.zdan.paimengaicodebackend.service;

import com.mybatisflex.core.paginate.Page;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.core.service.IService;
import com.zdan.paimengaicodebackend.model.dto.chathistory.ChatHistoryQueryRequest;
import com.zdan.paimengaicodebackend.model.entity.ChatHistory;
import com.zdan.paimengaicodebackend.model.entity.User;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import java.time.LocalDateTime;

public interface ChatHistoryService extends IService<ChatHistory> {
    int loadChatHistoryToMemory(Long appId, MessageWindowChatMemory chatMemory, int maxCount);

    Page<ChatHistory> listAppChatHistoryByPage(
        Long appId,
        int pageSize,
        LocalDateTime lastCreateTime,
        User loginUser
    );

    QueryWrapper getQueryWrapper(ChatHistoryQueryRequest chatHistoryQueryRequest);

    void addChatMessage(Long appId, String message, String messageType, User user);

    void removeByAppId(Long appId);
}
