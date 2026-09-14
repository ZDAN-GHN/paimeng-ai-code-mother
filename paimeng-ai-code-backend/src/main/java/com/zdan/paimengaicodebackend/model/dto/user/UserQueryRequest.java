package com.zdan.paimengaicodebackend.model.dto.user;

import com.zdan.paimengaicodebackend.common.PageRequest;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;
import lombok.EqualsAndHashCode;

@EqualsAndHashCode(callSuper = true)
@Data
public class UserQueryRequest extends PageRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 6834803587134948775L;

    private Long id;

    private String userName;

    private String userAccount;

    private String userProfile;

    private String userRole;
}
