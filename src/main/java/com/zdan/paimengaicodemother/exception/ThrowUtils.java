package com.zdan.paimengaicodemother.exception;

/**
 * 异常工具类，用于快速抛出异常
 *
 * @author LXH
 */
public class ThrowUtils {

    public static void throwForOperation(String message) {
        throwBusinessException(ErrorCode.OPERATION_ERROR, message);
    }

    public static void throwForNotLogin(String message) {
        throwBusinessException(ErrorCode.NOT_LOGIN_ERROR, message);
    }

    public static void throwForParam(String message) {
        throwBusinessException(ErrorCode.PARAMS_ERROR, message);
    }

    public static void throwBusinessException(ErrorCode errorCode, String message) {
        throw new BusinessException(errorCode, message);
    }

    /**
     * 条件成立则抛出异常
     *
     * @param condition
     * @param runtimeException
     */
    public static void throwIf(boolean condition, RuntimeException runtimeException) {
        if (condition) {
            throw runtimeException;
        }
    }

    /**
     * 条件成立则抛异常
     *
     * @param condition 条件
     * @param errorCode 错误码
     */
    public static void throwIf(boolean condition, ErrorCode errorCode) {
        throwIf(condition, new BusinessException(errorCode));
    }

    /**
     * 条件成立则抛异常
     *
     * @param condition 条件
     * @param errorCode 错误码
     * @param message   错误信息
     */
    public static void throwIf(boolean condition, ErrorCode errorCode, String message) {
        throwIf(condition, new BusinessException(errorCode, message));
    }
}
