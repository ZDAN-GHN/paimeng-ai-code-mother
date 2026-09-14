import re
from dataclasses import dataclass

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

INJECTION_PATTERNS = (
    re.compile(
        r"ignore\s+(?:previous|above|all)\s+(?:instructions?|commands?|prompts?)",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:forget|disregard)\s+(?:everything|all)\s+(?:above|before)", re.IGNORECASE
    ),
    re.compile(
        r"(?:pretend|act|behave)\s+(?:as|like)\s+(?:if|you\s+are)", re.IGNORECASE
    ),
    re.compile(r"system\s*:\s*you\s+are", re.IGNORECASE),
    re.compile(r"new\s+(?:instructions?|commands?|prompts?)\s*:", re.IGNORECASE),
)

MAX_INPUT_LENGTH = 1000


@dataclass(frozen=True)
class GuardrailResult:
    is_allowed: bool
    reason: str = ""

    @classmethod
    def allowed(cls) -> "GuardrailResult":

        return cls(is_allowed=True)

    @classmethod
    def rejected(cls, reason: str) -> "GuardrailResult":

        return cls(is_allowed=False, reason=reason)


class PromptSafetyInputGuardrail:
    def validate(self, input_text: str) -> GuardrailResult:

        if len(input_text) > MAX_INPUT_LENGTH:
            return GuardrailResult.rejected("输入内容过长，不要超过 1000 字")

        if input_text.strip() == "":
            return GuardrailResult.rejected("输入内容不能为空")

        lower_input = input_text.lower()
        for sensitive_word in SENSITIVE_WORDS:
            if sensitive_word.lower() in lower_input:
                return GuardrailResult.rejected("输入包含不当内容，请修改后重试")

        for pattern in INJECTION_PATTERNS:
            if pattern.search(input_text):
                return GuardrailResult.rejected("检测到恶意输入，请求被拒绝")
        return GuardrailResult.allowed()


_guardrail = PromptSafetyInputGuardrail()


def validate_prompt(input_text: str) -> GuardrailResult:

    return _guardrail.validate(input_text)
