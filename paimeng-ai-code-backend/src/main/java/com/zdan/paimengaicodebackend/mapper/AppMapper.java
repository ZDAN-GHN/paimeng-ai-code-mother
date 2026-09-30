package com.zdan.paimengaicodebackend.mapper;

import com.mybatisflex.core.BaseMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

public interface AppMapper extends BaseMapper<App> {
    @Select("SELECT id FROM app WHERE id = #{appId} FOR UPDATE")
    Long lockForPromotion(@Param("appId") Long appId);
}
