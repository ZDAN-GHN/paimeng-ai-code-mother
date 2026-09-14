package com.zdan.paimengaicodebackend.mapper;

import com.mybatisflex.core.BaseMapper;
import com.zdan.paimengaicodebackend.model.entity.User;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;


public interface UserMapper extends BaseMapper<User> {


    @Update("UPDATE user SET credits = credits - #{amount} WHERE id = #{userId} AND credits >= #{amount}")
    int deductCredits(@Param("userId") Long userId, @Param("amount") int amount);


    @Update("UPDATE user SET credits = credits + #{amount} WHERE id = #{userId}")
    int addCredits(@Param("userId") Long userId, @Param("amount") int amount);
}
