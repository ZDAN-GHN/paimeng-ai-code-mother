package com.zdan.paimengaicodebackend.model.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;

/**
 * 生成运行（generation_run）阶段枚举
 * 与 MySQL 中 generation_run.phase 列（显式 enum）一一对应；
 * 新增 phase = 显式契约变更（docs/ts_agent/architecture.md §3.2 收敛纪律①）。
 *
 * @author LXH
 */
@Getter
public enum GenerationRunPhaseEnum {

    /**
     * 需求访谈（免费阶段）
     */
    INTERVIEW("需求访谈", "interview"),

    /**
     * 线框已生成，等待用户确认（跨请求持久化等待，HITL 闸门）
     */
    WIREFRAME_PENDING("等待线框确认", "wireframe_pending"),

    /**
     * 线框已确认，进入 codegen 的布局契约
     */
    WIREFRAME_CONFIRMED("线框已确认", "wireframe_confirmed"),

    /**
     * 编码（planner → coder 循环）
     */
    CODING("编码中", "coding"),

    /**
     * 质量审查（reviewer）
     */
    REVIEW("质检中", "review"),

    /**
     * 构建中（Java BuilderExecutor 触发）
     */
    BUILDING("构建中", "building"),

    /**
     * 终态：成功
     */
    DONE("完成", "done"),

    /**
     * 终态：失败
     */
    FAILED("失败", "failed"),

    /**
     * 终态：用户中止
     */
    ABORTED("已中止", "aborted");

    private final String text;
    private final String value;

    GenerationRunPhaseEnum(String text, String value) {
        this.text = text;
        this.value = value;
    }

    /**
     * 根据 value 获取枚举
     *
     * @param value 枚举值的value
     * @return 枚举值，未匹配返回 null
     */
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

    /**
     * 是否为终态（done/failed/aborted）；非终态 run 用于断点续传与并发拒绝判定
     *
     * @param phase 阶段枚举
     * @return true 表示终态
     */
    public static boolean isTerminal(GenerationRunPhaseEnum phase) {
        return phase == DONE || phase == FAILED || phase == ABORTED;
    }
}
