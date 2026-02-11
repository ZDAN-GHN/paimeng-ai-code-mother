package com.zdan.paimengaicodemother.model.dto.user;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;

/**
 * 更新用户请求
 *
 * @author LXH
 */
@Data
public class UserUpdateRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 353379635326765571L;

    /**
     * id
     */
    private Long id;

    /**
     * 用户昵称
     */
    private String userName;

    /**
     * 用户头像
     */
    private String userAvatar;

    /**
     * 简介
     */
    private String userProfile;

    /**
     * 用户角色：user/admin
     */
    private String userRole;
}