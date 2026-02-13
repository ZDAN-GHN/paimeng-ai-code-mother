package com.zdan.paimengaicodemother.model.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;

/**
 * 代码生成类型枚举
 *
 * @author LXH
 */
@Getter
public enum CodeGenTypeEnum {

    HTML("原生 HTML 模式", "html", StreamTypeEnum.FLUX),
    MULTI_FILE("原生多文件模式", "multi_file", StreamTypeEnum.FLUX),
    VUE_PROJECT("Vue 工程模式", "vue_project", StreamTypeEnum.TOKEN),
    ;

    private final String text;
    private final String value;
    private final StreamTypeEnum streamType;

    CodeGenTypeEnum(String text, String value, StreamTypeEnum streamType) {
        this.text = text;
        this.value = value;
        this.streamType = streamType;
    }

    /**
     * 根据 value 获取枚举
     *
     * @param value 枚举值的value
     * @return 枚举值
     */
    public static CodeGenTypeEnum getEnumByValue(String value) {
        if (ObjUtil.isEmpty(value)) {
            return null;
        }
        for (CodeGenTypeEnum anEnum : CodeGenTypeEnum.values()) {
            if (anEnum.value.equals(value)) {
                return anEnum;
            }
        }
        return null;
    }

    /**
     * AI 响应流类型枚举
     *
     * @author LXH
     */
    @Getter
    public enum StreamTypeEnum {


        FLUX("使用 Flux ", "flux"),
        TOKEN("使用 TokenStream ", "token"),
        ;

        private final String text;
        private final String value;

        StreamTypeEnum(String text, String value) {
            this.text = text;
            this.value = value;
        }

        /**
         * 根据 value 获取枚举
         *
         * @param value 枚举值的value
         * @return 枚举值
         */
        public static StreamTypeEnum getEnumByValue(String value) {
            if (ObjUtil.isEmpty(value)) {
                return null;
            }
            for (StreamTypeEnum anEnum : StreamTypeEnum.values()) {
                if (anEnum.value.equals(value)) {
                    return anEnum;
                }
            }
            return null;
        }

    }
}