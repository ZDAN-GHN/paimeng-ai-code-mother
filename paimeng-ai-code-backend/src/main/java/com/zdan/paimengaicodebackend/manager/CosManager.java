package com.zdan.paimengaicodebackend.manager;

import com.qcloud.cos.COSClient;
import com.qcloud.cos.model.PutObjectRequest;
import com.qcloud.cos.model.PutObjectResult;
import com.zdan.paimengaicodebackend.config.CosClientConfig;
import jakarta.annotation.Resource;
import java.io.File;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnBean(COSClient.class)
@Slf4j
public class CosManager {

    @Resource
    private CosClientConfig cosClientConfig;

    @Resource
    private COSClient cosClient;

    public PutObjectResult putObject(String key, File file) {
        PutObjectRequest putObjectRequest = new PutObjectRequest(
            cosClientConfig.getBucket(),
            key,
            file
        );
        return cosClient.putObject(putObjectRequest);
    }

    public String uploadFile(String key, File file) {
        PutObjectResult result = putObject(key, file);
        if (result != null) {
            String url = String.format("%s%s", cosClientConfig.getHost(), key);
            log.info("文件上传到 COS 成功：{} -> {}", file.getName(), url);
            return url;
        } else {
            log.error("文件上传到 COS 失败：{}，返回结果为空", file.getName());
            return null;
        }
    }
}
