package com.zdan.paimengaicodebackend.model.dto.run;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;


@Data
public class CreditFreezeRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;


    private String intensity;
}
