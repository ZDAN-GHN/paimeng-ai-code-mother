package com.zdan.paimengaicodemother.core.parser;

/**
 * 代码解析器接口
 *
 * @author LXH
 */
public interface ICodeParser {

    /**
     * 解析代码
     *
     * @param codeContent 代码内容
     * @return 解析结果
     */
    <T> T parseCode(String codeContent);
}
