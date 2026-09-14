package com.zdan.paimengaicodebackend.model.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;

@Getter
public enum GenerationRunPhaseEnum {
    INTERVIEW("需求访谈", "interview"),
    WIREFRAME_PENDING("等待线框确认", "wireframe_pending"),
    WIREFRAME_CONFIRMED("线框已确认", "wireframe_confirmed"),
    CODING("编码中", "coding"),
    REVIEW("质检中", "review"),
    BUILDING("构建中", "building"),
    DONE("完成", "done"),
    FAILED("失败", "failed"),
    ABORTED("已中止", "aborted");

    private final String text;
    private final String value;

    GenerationRunPhaseEnum(String text, String value) {
        this.text = text;
        this.value = value;
    }

    public static GenerationRunPhaseEnum getEnumByValue(String value) {
        if (ObjUtil.isEmpty(value)) {
            return null;
        }
        for (GenerationRunPhaseEnum anEnum : GenerationRunPhaseEnum.values()) {
            if (anEnum.value.equals(value)) {
                return anEnum;
            }
        }
        return null;
    }

    public static boolean isTerminal(GenerationRunPhaseEnum phase) {
        return phase == DONE || phase == FAILED || phase == ABORTED;
    }
}
