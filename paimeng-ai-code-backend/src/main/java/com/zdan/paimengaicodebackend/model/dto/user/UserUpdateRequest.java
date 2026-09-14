package com.zdan.paimengaicodebackend.model.dto.user;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;


@Data
public class UserUpdateRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 353379635326765571L;


    private Long id;


    private String userName;


    private String userAvatar;


    private String userProfile;


    private String userRole;
}