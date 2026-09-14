package com.zdan.paimengaicodebackend.model.vo;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;


@Data
public class UserVO implements Serializable {

    @Serial
    private static final long serialVersionUID = 5660224407760108276L;


    private Long id;


    private String userAccount;


    private String userName;


    private String userAvatar;


    private String userProfile;


    private String userRole;
}