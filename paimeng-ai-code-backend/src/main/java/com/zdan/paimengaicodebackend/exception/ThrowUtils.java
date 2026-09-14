package com.zdan.paimengaicodebackend.exception;


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


    public static void throwIf(boolean condition, RuntimeException runtimeException) {
        if (condition) {
            throw runtimeException;
        }
    }


    public static void throwIf(boolean condition, ErrorCode errorCode) {
        throwIf(condition, new BusinessException(errorCode));
    }


    public static void throwIf(boolean condition, ErrorCode errorCode, String message) {
        throwIf(condition, new BusinessException(errorCode, message));
    }
}
