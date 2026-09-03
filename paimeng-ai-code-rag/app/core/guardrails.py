"""提示词安全输入护轨（对齐 Java ai/guardrail/PromptSafetyInputGuardrail）。

在工作流进入代码生成前对用户提示词做安全检查，
包含输入长度、空输入、敏感词与注入攻击模式四类校验。
"""

import re
from dataclasses import dataclass

# 敏感词列表（对齐 Java SENSITIVE_WORDS，匹配时不区分大小写）
SENSITIVE_WORDS = (
    "忽略之前的指令",
    "ignore previous instructions",
    "ignore above",
    "破解",
    "hack",
    "绕过",
    "bypass",
    "越狱",
    "jailbreak",
)

# 注入攻击模式（对齐 Java INJECTION_PATTERNS，匹配时不区分大小写）
INJECTION_PATTERNS = (
    re.compile(r"ignore\s+(?:previous|above|all)\s+(?:instructions?|commands?|prompts?)", re.IGNORECASE),
    re.compile(r"(?:forget|disregard)\s+(?:everything|all)\s+(?:above|before)", re.IGNORECASE),
    re.compile(r"(?:pretend|act|behave)\s+(?:as|like)\s+(?:if|you\s+are)", re.IGNORECASE),
    re.compile(r"system\s*:\s*you\s+are", re.IGNORECASE),
    re.compile(r"new\s+(?:instructions?|commands?|prompts?)\s*:", re.IGNORECASE),
)

# 输入最大长度（对齐 Java 1000 字）
MAX_INPUT_LENGTH = 1000


@dataclass(frozen=True)
class GuardrailResult:
    """护轨校验结果。"""

    is_allowed: bool
    reason: str = ""

    @classmethod
    def allowed(cls) -> "GuardrailResult":
        """校验通过。"""
        return cls(is_allowed=True)

    @classmethod
    def rejected(cls, reason: str) -> "GuardrailResult":
        """校验拒绝。"""
        return cls(is_allowed=False, reason=reason)


class PromptSafetyInputGuardrail:
    """提示词安全输入护轨。

    逐条校验输入，任一规则触发即返回拒绝结果；
    校验通过返回 allowed。规则顺序与 Java 实现一致。
    """

    def validate(self, input_text: str) -> GuardrailResult:
        """校验输入提示词。

        :param input_text: 用户输入内容
        :return: 校验结果
        """
        # 检查输入长度
        if len(input_text) > MAX_INPUT_LENGTH:
            return GuardrailResult.rejected("输入内容过长，不要超过 1000 字")
        # 检查是否为空
        if input_text.strip() == "":
            return GuardrailResult.rejected("输入内容不能为空")
        # 检查敏感词
        lower_input = input_text.lower()
        for sensitive_word in SENSITIVE_WORDS:
            if sensitive_word.lower() in lower_input:
                return GuardrailResult.rejected("输入包含不当内容，请修改后重试")
        # 检查注入攻击模式
        for pattern in INJECTION_PATTERNS:
            if pattern.search(input_text):
                return GuardrailResult.rejected("检测到恶意输入，请求被拒绝")
        return GuardrailResult.allowed()


_guardrail = PromptSafetyInputGuardrail()


def validate_prompt(input_text: str) -> GuardrailResult:
    """模块级便捷函数：校验用户提示词。

    :param input_text: 用户输入内容
    :return: 校验结果
    """
    return _guardrail.validate(input_text)
