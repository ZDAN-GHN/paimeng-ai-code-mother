package com.zdan.paimengaicodebackend.model.dto.user;

import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

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
