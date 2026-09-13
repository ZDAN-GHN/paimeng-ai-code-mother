package com.zdan.paimengaicodemother.utils;

import cn.hutool.crypto.digest.DigestUtil;
import cn.hutool.json.JSONUtil;

/**
 * 缓存 key 生成工具
 *
 * @author LXH
 */
public class CacheKeyUtils {

    private CacheKeyUtils() {
    }

    public static String generateKey(Object obj) {
        // 空值就返回固定值
        if (obj == null) {
            return DigestUtil.md5Hex("null");
        }
        // 非空就转成 json 字符串，再转成 md5
        String jsonStr = JSONUtil.toJsonStr(obj);
        return DigestUtil.md5Hex(jsonStr);
    }
}
