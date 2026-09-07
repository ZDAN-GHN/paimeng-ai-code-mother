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
import java.util.List;

/**
 * 全网热词图片搜索工具
 * 基于 SearXNG 聚合搜索引擎检索图片，覆盖游戏、动漫、品牌等素材库无法收录的网络热词内容；图片来源公开网络，版权状态不确定
 *
 * @author LXH
 */
@Slf4j
@Component
public class WebImageSearchTool {

    private static final int SEARCH_COUNT = 8;

    @Value("${searxng.base-url:http://127.0.0.1:8080}")
    private String searxngBaseUrl;

    @Tool("搜索全网图片素材，覆盖游戏、动漫、品牌、明星等网络热词内容；图片来源公开网络，版权状态不确定，仅用于预览展示")
    public List<ImageResource> searchWebImages(@P("搜索关键词") String query) {
        List<ImageResource> imageList = new ArrayList<>();
        // 调用 API，注意释放资源
        try (HttpResponse response = HttpRequest.get(searxngBaseUrl + "/search")
                .header("Accept", "application/json")
                .form("q", query)
                .form("categories", "images")
                .form("format", "json")
                .form("safesearch", 1)
                .timeout(15000)
                .execute()) {
            if (response.isOk()) {
                JSONArray results = JSONUtil.parseObj(response.body()).getJSONArray("results");
                for (int i = 0; i < results.size() && imageList.size() < SEARCH_COUNT; i++) {
                    JSONObject result = results.getJSONObject(i);
                    // img_src 为原图直链，部分结果卡片缺失该字段（图片类目下也会混入无图结果）
                    String imgUrl = result.getStr("img_src");
                    if (StrUtil.isBlank(imgUrl)) {
                        continue;
                    }
                    imageList.add(ImageResource.builder()
                            .category(ImageCategoryEnum.CONTENT)
                            .description(result.getStr("title", query))
                            .url(imgUrl)
                            .build());
                }
            } else {
                log.error("SearXNG 图片搜索响应异常, status: {}", response.getStatus());
            }
        } catch (Exception e) {
            log.error("SearXNG 图片搜索调用失败: {}", e.getMessage(), e);
        }
        return imageList;
    }
}
