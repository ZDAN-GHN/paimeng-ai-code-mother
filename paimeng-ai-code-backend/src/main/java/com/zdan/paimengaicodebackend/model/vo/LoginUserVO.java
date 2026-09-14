package com.zdan.paimengaicodebackend.model.vo;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;
import java.time.LocalDateTime;


@Data
public class LoginUserVO implements Serializable {

    @Serial
    private static final long serialVersionUID = -1305196173707729260L;


    private Long id;


    private String userAccount;


    private String userName;


    private String userAvatar;


    private String userProfile;


    private String userRole;


    private Integer credits;


    private LocalDateTime createTime;
}