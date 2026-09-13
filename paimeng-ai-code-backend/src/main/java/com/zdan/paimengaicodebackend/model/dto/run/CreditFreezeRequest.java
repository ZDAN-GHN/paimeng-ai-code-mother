package com.zdan.paimengaicodebackend.model.dto.run;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;

/**
 * 冻结积分请求（Java 内部 API，由 TS Agent 在「确认线框进入 codegen」时刻调用，Issue #10）
 * appId/userId 由 Java 从 run 读取（run 已含归属，契约不冗余）；codeGenType 由 Java 按 app 查询；
 * 仅 intensity（推理强度档位）为计费档位系数来源，由 TS Agent 从请求体透传。
 *
 * @author LXH
 */
@Data
public class CreditFreezeRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    /**
     * 推理强度档位：fast/standard/deep（对应 AgentProperties.Credit 档位系数）
     */
    private String intensity;
}
