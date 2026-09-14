package com.zdan.paimengaicodebackend.model.vo;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;


@Data
public class CreditFreezeVO implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;


    private Long ledgerId;


    private Integer frozenAmount;


    private Integer balance;
}
