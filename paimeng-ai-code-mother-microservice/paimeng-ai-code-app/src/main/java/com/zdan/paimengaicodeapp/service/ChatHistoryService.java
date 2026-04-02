package com.zdan.paimengaicodeapp.service;

import com.mybatisflex.core.paginate.Page;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.core.service.IService;
import com.zdan.paimengaicodemother.model.dto.chathistory.ChatHistoryQueryRequest;
import com.zdan.paimengaicodemother.model.entity.ChatHistory;
import com.zdan.paimengaicodemother.model.entity.User;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;

import java.time.LocalDateTime;

/**
 * 对话历史 服务层。
 *
 * @author LXH
 */
public interface ChatHistoryService extends IService<ChatHistory> {

    /**
     * 加载对话历史到对话记忆中
     *
     * @param appId      应用 id
     * @param chatMemory 对话记忆实体
     * @param maxCount   最大记忆数量
     * @return 加载数量
     */
    int loadChatHistoryToMemory(Long appId, MessageWindowChatMemory chatMemory, int maxCount);

    /**
     * 获取应用对话历史（根据游标查询）
     *
     * @param appId          应用 id
     * @param pageSize       分页大小
     * @param lastCreateTime 上次游标对应的创建时间
     * @param loginUser      当前登录用户
     * @return 对话历史实体分页
     */
    Page<ChatHistory> listAppChatHistoryByPage(Long appId, int pageSize,
                                               LocalDateTime lastCreateTime,
                                               User loginUser);

    /**
     * 获取查询包装类
     *
     * @param chatHistoryQueryRequest 查询请求对象
     * @return 查询包装器
     */
    QueryWrapper getQueryWrapper(ChatHistoryQueryRequest chatHistoryQueryRequest);

    /**
     * 添加会话消息
     *
     * @param appId       应用 id
     * @param message     消息内容
     * @param messageType 消息类型
     * @param user        会话归属用户
     */
    void addChatMessage(Long appId, String message, String messageType, User user);

    /**
     * 根据应用 id 删除会话历史
     *
     * @param appId 应用 id
     */
    void removeByAppId(Long appId);
}
