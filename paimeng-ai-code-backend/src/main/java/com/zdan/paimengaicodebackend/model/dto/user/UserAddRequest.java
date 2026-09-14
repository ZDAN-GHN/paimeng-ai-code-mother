package com.zdan.paimengaicodebackend.model.dto.user;

import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
public class UserAddRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 2514439254898824553L;

    private String userName;

    private String userAccount;

    private String userAvatar;

    private String userProfile;

    private String userRole;
}
