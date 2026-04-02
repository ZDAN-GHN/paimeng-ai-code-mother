package com.zdan.paimengaicodemother.common;

import com.zdan.paimengaicodemother.exception.ErrorCode;
import lombok.Data;

import java.io.Serializable;

/**
 * 通过响应类
 *
 * @param <T>
 * @author LXH
 */
@Data
public class BaseResponse<T> implements Serializable {

    private int code;

    private T data;

    private String message;

    /**
     * 该方法仅用于 @Cacheable 反序列化 redis 存储值时，
     * 反射调用无参构造方法创建对象，所以设置为 private
     */
    private BaseResponse() {
    }

    public BaseResponse(int code, T data, String message) {
        this.code = code;
        this.data = data;
        this.message = message;
    }

    public BaseResponse(int code, T data) {
        this(code, data, "");
    }

    public BaseResponse(ErrorCode errorCode) {
        this(errorCode.getCode(), null, errorCode.getMessage());
    }
}
