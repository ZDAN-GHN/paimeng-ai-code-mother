package com.zdan.paimengaicodemother.ai.model.message;

import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;

/**
 * Ai 思考消息
 *
 * @author LXH
 */
@EqualsAndHashCode(callSuper = true)
@Data
@NoArgsConstructor
public class AiThinkingMessage extends StreamMessage {

    private String text;

    public AiThinkingMessage(String text) {
        super(StreamMessageTypeEnum.AI_THINkING.getValue());
        this.text = text;
    }
}
