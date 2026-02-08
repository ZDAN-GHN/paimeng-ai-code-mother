package com.zdan.paimengaicodemother.model.vo;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;

/**
 * 用户视图
 *
 * @author LXH
 */
@Data
public class UserVO implements Serializable {

    @Serial
    private static final long serialVersionUID = 5660224407760108276L;

    /**
     * id
     */
    private Long id;

    /**
     * 账号
     */
    private String userAccount;

    /**
     * 用户昵称
     */
    private String userName;

    /**
     * 用户头像
     */
    private String userAvatar;

    /**
     * 用户简介
     */
    private String userProfile;

    /**
     * 用户角色：user/admin
     */
    private String userRole;
}