package com.zdan.paimengaicodemother.langgraph4j.tools;


import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HttpRequest;
import cn.hutool.http.HttpResponse;
import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;
import com.zdan.paimengaicodemother.langgraph4j.model.ImageResource;
import com.zdan.paimengaicodemother.langgraph4j.model.enums.ImageCategoryEnum;
import dev.langchain4j.agent.tool.P;
import dev.langchain4j.agent.tool.Tool;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * logo 图片生成工具
 * 根据文本描述生成对应 logo 图片（使用硅基流动的 Kolors 模型进行生成，官方返回的图片 url 有效期仅一小时）
 *
 * @author LXH
 */
@Slf4j
@Component
public class LogoGeneratorTool {

    private static final String SILICONFLOW_API_URL = "https://api.siliconflow.cn/v1/images/generations";

    @Value("${siliconflow.api-key:}")
    private String siliconflowApiKey;

    @Value("${siliconflow.image-model:Kwai-Kolors/Kolors}") // 如果模型值没有填则默认为 "Kwai-Kolors/Kolors"
    private String imageModel;

    @Tool("根据描述生成 Logo 设计图片，用于网站品牌标识")
    public List<ImageResource> generateLogos(@P("Logo 设计描述，如名称、行业、风格等，尽量详细") String description) {
        List<ImageResource> logoList = new ArrayList<>();
        try {
            // 构建 Logo 设计提示词
            String logoPrompt = String.format("生成 Logo，Logo 中禁止包含任何文字！Logo 介绍：%s", description);
            Map<String, Object> paramMap = new HashMap<>();
            paramMap.put("model", imageModel);
            paramMap.put("prompt", logoPrompt);
            // 官方推荐值列表里没有 512，用 1:1 的推荐尺寸保证生成质量
            paramMap.put("image_size", "1024x1024");
            paramMap.put("batch_size", 1); // 生成 1 张足够，因为 AI 不知道哪张最好
            // 调用 API，注意释放资源
            try (HttpResponse response = HttpRequest.post(SILICONFLOW_API_URL)
                    .header("Authorization", "Bearer " + siliconflowApiKey)
                    .header("Content-Type", "application/json")
                    .body(JSONUtil.toJsonStr(paramMap))
                    .execute()) {
                if (response.isOk()) {
                    // 数据封装
                    JSONArray images = JSONUtil.parseObj(response.body()).getJSONArray("images");
                    for (int i = 0; i < images.size(); i++) {
                        JSONObject image = images.getJSONObject(i);
                        String imageUrl = image.getStr("url");
                        if (StrUtil.isNotBlank(imageUrl)) {
                            logoList.add(ImageResource.builder()
                                    .category(ImageCategoryEnum.LOGO)
                                    .description(description)
                                    .url(imageUrl)
                                    .build());
                        }
                    }
                } else {
                    log.error("硅基流动图片生成接口返回异常: status={}, body={}", response.getStatus(), response.body());
                }
            }
        } catch (Exception e) {
            log.error("生成 Logo 失败: {}", e.getMessage(), e);
        }
        return logoList;
    }
}
