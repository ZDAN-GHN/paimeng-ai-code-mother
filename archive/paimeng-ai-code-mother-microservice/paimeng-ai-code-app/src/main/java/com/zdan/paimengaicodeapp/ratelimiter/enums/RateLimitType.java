package com.zdan.paimengaicodeapp.ratelimiter.enums;

/**
 * 限流类型枚举，即被限流的对象
 *
 * @author LXH
 */
public enum RateLimitType {
    
    /**
     * 接口级别限流
     */
    API,
    
    /**
     * 用户级别限流
     */
    USER,
    
    /**
     * IP级别限流
     */
    IP
}