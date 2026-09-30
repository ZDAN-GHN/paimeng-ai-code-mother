package com.zdan.paimengaicodebackend.mapper;

import com.mybatisflex.core.BaseMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
public interface AppMapper extends BaseMapper<App> {

    /**
     * 锁定 Application 行：晋升与首次 Release 是同一条序列化链上的两步（CT-004 把它们列为
     * 同一契约的输出），共用这一个行锁，避免两个写入者各自看到「还没有 Release」。
     */
    @Select("SELECT id FROM app WHERE id = #{appId} FOR UPDATE")
    Long lockApplication(@Param("appId") Long appId);
}
