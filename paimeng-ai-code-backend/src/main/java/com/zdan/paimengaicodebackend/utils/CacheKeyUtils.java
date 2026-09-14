package com.zdan.paimengaicodebackend.utils;

import cn.hutool.crypto.digest.DigestUtil;
import cn.hutool.json.JSONUtil;


public class CacheKeyUtils {

    private CacheKeyUtils() {
    }

    public static String generateKey(Object obj) {

        if (obj == null) {
            return DigestUtil.md5Hex("null");
        }

        String jsonStr = JSONUtil.toJsonStr(obj);
        return DigestUtil.md5Hex(jsonStr);
    }
}
