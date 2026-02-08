package com.zdan.paimengaicodemother.model.dto;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;

/**
 * 用户注册请求
 *
 * @author LXH
 */
@Data
public class UserRegisterRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 3191241716373120793L;

    /**
     * 账号
     */
    private String userAccount;

    /**
     * 密码
     */
    private String userPassword;

    /**
     * 确认密码
     */
    private String checkPassword;
}