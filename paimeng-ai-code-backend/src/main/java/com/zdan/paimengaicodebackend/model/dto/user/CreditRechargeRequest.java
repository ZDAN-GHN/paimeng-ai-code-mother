package com.zdan.paimengaicodebackend.model.dto.user;

import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
public class CreditRechargeRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    private Long userId;

    private Integer credits;
}
