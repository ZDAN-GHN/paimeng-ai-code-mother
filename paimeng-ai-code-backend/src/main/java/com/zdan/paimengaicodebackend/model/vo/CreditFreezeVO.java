package com.zdan.paimengaicodebackend.model.vo;

import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
public class CreditFreezeVO implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    private Long ledgerId;

    private Integer frozenAmount;

    private Integer balance;
}
