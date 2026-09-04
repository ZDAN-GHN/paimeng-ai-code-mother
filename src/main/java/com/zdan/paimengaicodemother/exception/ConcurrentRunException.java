package com.zdan.paimengaicodemother.exception;

/**
 * 并发运行冲突异常
 * 同 app 已存在非终态 run 时再次创建 run 抛出（Java 内部 API 映射为 HTTP 409「当前有进行中的任务」）。
 *
 * @author LXH
 */
public class ConcurrentRunException extends RuntimeException {

    public ConcurrentRunException(String message) {
        super(message);
    }
}
