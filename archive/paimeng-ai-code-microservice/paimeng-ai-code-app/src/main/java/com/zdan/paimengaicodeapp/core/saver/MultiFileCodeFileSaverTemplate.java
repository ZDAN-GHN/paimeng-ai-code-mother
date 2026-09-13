package com.zdan.paimengaicodeapp.core.saver;

import cn.hutool.core.util.StrUtil;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.ai.model.MultiFileCodeResult;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;

/**
 * 多文件代码保存器
 *
 * @author LXH
 */
@CodeFileSaver(codeGenTypeEnum = CodeGenTypeEnum.MULTI_FILE)
public class MultiFileCodeFileSaverTemplate extends BaseCodeFileSaver {

    @Override
    protected CodeGenTypeEnum getCodeType() {
        return CodeGenTypeEnum.MULTI_FILE;
    }

    @Override
    protected void saveFiles(Object result, String baseDirPath) {
        MultiFileCodeResult multiFileCodeResult = (MultiFileCodeResult) result;
        // 保存 HTML 文件
        writeToFile(baseDirPath, "index.html", multiFileCodeResult.getHtmlCode());
        // 保存 CSS 文件
        writeToFile(baseDirPath, "style.css", multiFileCodeResult.getCssCode());
        // 保存 JavaScript 文件
        writeToFile(baseDirPath, "script.js", multiFileCodeResult.getJsCode());
    }

    @Override
    protected void validateInput(Object result, Long appId) {
        super.validateInput(result, appId);
        // 至少要有 HTML 代码，CSS 和 JS 可以为空
        if (StrUtil.isBlank(((MultiFileCodeResult) result).getHtmlCode())) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "HTML代码内容不能为空");
        }
    }
}