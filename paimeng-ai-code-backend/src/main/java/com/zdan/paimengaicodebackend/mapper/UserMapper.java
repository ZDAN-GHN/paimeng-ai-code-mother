package com.zdan.paimengaicodebackend.mapper;

import com.mybatisflex.core.BaseMapper;
import com.zdan.paimengaicodebackend.model.entity.User;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

/**
 * 用户 映射层
 *
 * @author LXH
 */
public interface UserMapper extends BaseMapper<User> {

    /**
     * 原子扣减积分（Issue #10 审查整改：消除读改写丢更新——并发冻结同用户余额不再互相覆盖）
     * WHERE credits >= amount 保证余额不足时 affected=0（调用方据此判 CREDIT_NOT_ENOUGH），不超扣。
     *
     * @param userId 用户 id
     * @param amount 扣减积分数
     * @return 受影响行数（0 = 余额不足或用户不存在）
     */
    @Update("UPDATE user SET credits = credits - #{amount} WHERE id = #{userId} AND credits >= #{amount}")
    int deductCredits(@Param("userId") Long userId, @Param("amount") int amount);

    /**
     * 原子增加积分（充值/退款加回，避免读改写竞态）
     *
     * @param userId 用户 id
     * @param amount 增加积分数
     * @return 受影响行数（0 = 用户不存在）
     */
    @Update("UPDATE user SET credits = credits + #{amount} WHERE id = #{userId}")
    int addCredits(@Param("userId") Long userId, @Param("amount") int amount);
}
