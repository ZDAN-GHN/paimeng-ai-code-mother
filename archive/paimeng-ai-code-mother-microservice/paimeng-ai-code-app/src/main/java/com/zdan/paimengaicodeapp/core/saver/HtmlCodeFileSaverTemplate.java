package com.zdan.paimengaicodeapp.core.saver;


import cn.hutool.core.util.StrUtil;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.ai.model.HtmlCodeResult;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;

/**
 * HTML代码文件保存器
 *
 * @author LXH
 */
@CodeFileSaver(codeGenTypeEnum = CodeGenTypeEnum.HTML)
public class HtmlCodeFileSaverTemplate extends BaseCodeFileSaver {

    @Override
    protected CodeGenTypeEnum getCodeType() {
        return CodeGenTypeEnum.HTML;
    }

    @Override
    protected void saveFiles(Object result, String baseDirPath) {
        writeToFile(baseDirPath, "index.html", ((HtmlCodeResult) result).getHtmlCode());
    }

    @Override
    protected void validateInput(Object result, Long appId) {
        super.validateInput(result, appId);
        // HTML 代码不能为空
        if (StrUtil.isBlank(((HtmlCodeResult) result).getHtmlCode())) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "HTML 代码不能为空");
        }
    }
}
