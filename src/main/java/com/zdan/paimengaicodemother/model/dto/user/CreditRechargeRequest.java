package com.zdan.paimengaicodemother.model.dto.user;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;

/**
 * 积分充值请求（管理员后台手动充值，架构 §7 MVP 后台充值）
 * 仅管理员可调用（@AuthCheck(ADMIN_ROLE)）；只做积分入账，不改动其他用户信息。
 *
 * @author LXH
 */
@Data
public class CreditRechargeRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    /**
     * 目标用户 id
     */
    private Long userId;

    /**
     * 充值积分数（正数）
     */
    private Integer credits;
}
