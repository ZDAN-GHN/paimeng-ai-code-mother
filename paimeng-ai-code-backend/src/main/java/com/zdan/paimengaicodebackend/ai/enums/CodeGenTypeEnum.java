package com.zdan.paimengaicodebackend.ai.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;


@Getter
public enum CodeGenTypeEnum {

    HTML("原生 HTML 模式", "html", BuildTypeEnum.NONE),
    MULTI_FILE("原生多文件模式", "multi_file", BuildTypeEnum.NONE),
    VUE_PROJECT("Vue 工程模式", "vue_project", BuildTypeEnum.NPM),
    ;

    private final String text;
    private final String value;
    private final BuildTypeEnum buildType;

    CodeGenTypeEnum(String text, String value, BuildTypeEnum buildType) {
        this.text = text;
        this.value = value;
        this.buildType = buildType;
    }


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


    @Getter
    public enum BuildTypeEnum {

        NONE("不需要构建", "none"),
        NPM("使用 npm 构建 ", "npm"),
        ;

        private final String text;
        private final String value;

        BuildTypeEnum(String text, String value) {
            this.text = text;
            this.value = value;
        }


        public static BuildTypeEnum getEnumByValue(String value) {
            if (ObjUtil.isEmpty(value)) {
                return null;
            }
            for (BuildTypeEnum anEnum : BuildTypeEnum.values()) {
                if (anEnum.value.equals(value)) {
                    return anEnum;
                }
            }
            return null;
        }

    }
}