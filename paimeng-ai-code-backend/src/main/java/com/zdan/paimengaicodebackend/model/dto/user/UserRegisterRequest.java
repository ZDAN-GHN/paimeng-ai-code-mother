package com.zdan.paimengaicodebackend.model.dto.user;

import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
public class UserRegisterRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 3191241716373120793L;

    private String userAccount;

    private String userPassword;

    private String checkPassword;
}
