package com.zdan.paimengaicodebackend.mapper.platform;

import com.zdan.paimengaicodebackend.platform.entity.PlatformValidationQueueEvent;
import com.mybatisflex.core.BaseMapper;
import org.apache.ibatis.annotations.Mapper;

/**
 * 验证队列审计事件数据访问
 */
@Mapper
public interface PlatformValidationQueueEventMapper extends BaseMapper<PlatformValidationQueueEvent> {
}
