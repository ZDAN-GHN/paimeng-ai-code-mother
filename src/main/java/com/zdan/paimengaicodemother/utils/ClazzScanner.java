package com.zdan.paimengaicodemother.utils;

import cn.hutool.core.collection.CollectionUtil;
import cn.hutool.core.lang.ClassScanner;
import cn.hutool.core.lang.Filter;
import com.zdan.paimengaicodemother.PaimengAiCodeMotherApplication;
import com.zdan.paimengaicodemother.ai.codegen.CodeGenType;
import com.zdan.paimengaicodemother.ai.codegen.AiCodeGenService;

import java.lang.annotation.Annotation;
import java.util.HashSet;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 基于 class 的字节码扫描器，主要用于获取添加上注解的接口或类的字节码对象
 *
 * @author LXH
 */
public class ClazzScanner {

    private ClazzScanner() {
    }

    /**
     * 从项目根包下查找
     */
    public static <T> Set<Class<? extends T>> scanInterfaces(
            Class<? extends Annotation> annotationClass,
            Class<T> interfaceClass
    ) {
        return scanInterfaces(PaimengAiCodeMotherApplication.class.getPackageName(), annotationClass, interfaceClass);
    }

    /**
     * 扫描指定包下符合条件的接口
     *
     * @param basePackage     要扫描的基础包名（如：com.example.service）
     * @param annotationClass 筛选的注解类型（null表示不按注解筛选）
     * @param interfaceClass  筛选的父接口类型（null表示不按父接口筛选）
     * @return 符合条件的接口集合
     */
    public static <T> Set<Class<? extends T>> scanInterfaces(
            String basePackage,
            Class<? extends Annotation> annotationClass,
            Class<T> interfaceClass
    ) {
        // 空包名校验
        if (basePackage == null || basePackage.trim().isEmpty()) {
            throw new IllegalArgumentException("扫描的包名不能为空！");
        }

        // 构建筛选条件
        Filter<Class<?>> clazzFilter = (clazz) -> {
            // 必须是接口
            boolean anInterface = clazz.isInterface();
            boolean hasAnnotation = true;
            boolean extendInterface = true;
            // 可选：有指定的注解
            if (annotationClass != null) {
                hasAnnotation = clazz.isAnnotationPresent(annotationClass);
            }
            // 可选：继承指定的父接口
            if (interfaceClass != null) {
                extendInterface = interfaceClass.isAssignableFrom(clazz) && !clazz.equals(interfaceClass);
            }
            return anInterface && hasAnnotation && extendInterface;
        };

        // 执行扫描：使用 Hutool 的 ClassScanner，传入筛选条件
        Set<Class<? extends T>> scanResult = ClassScanner.scanPackage(basePackage, clazzFilter).stream()
                .map(clazz -> (Class<T>) clazz)
                .collect(Collectors.toSet());

        // 返回非空集合（避免空指针）
        return CollectionUtil.isEmpty(scanResult) ? new HashSet<>() : scanResult;
    }

    // ========== 测试示例 ==========
    public static void main(String[] args) {
        scanInterfaces(CodeGenType.class.getPackageName(), CodeGenType.class, AiCodeGenService.class);
    }
}