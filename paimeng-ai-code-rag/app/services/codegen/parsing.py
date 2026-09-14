import re
from dataclasses import dataclass, field

HTML_PATTERN = re.compile(r"```html\s*\n([\s\S]*?)```", re.IGNORECASE)
CSS_PATTERN = re.compile(r"```css\s*\n([\s\S]*?)```", re.IGNORECASE)
JS_PATTERN = re.compile(r"```(?:js|javascript)\s*\n([\s\S]*?)```", re.IGNORECASE)


@dataclass
class HtmlCodeResult:
    html_code: str = ""
    description: str = ""


@dataclass
class MultiFileCodeResult:
    html_code: str = ""
    css_code: str = ""
    js_code: str = ""
    description: str = ""


def parse_html_code(code_content: str) -> HtmlCodeResult:

    matcher = HTML_PATTERN.search(code_content)
    if matcher and matcher.group(1).strip():
        return HtmlCodeResult(html_code=matcher.group(1).strip())
    return HtmlCodeResult(html_code=code_content.strip())


def parse_multi_file_code(code_content: str) -> MultiFileCodeResult:

    result = MultiFileCodeResult()

    def extract(pattern: re.Pattern[str]) -> str:
        matcher = pattern.search(code_content)
        return matcher.group(1).strip() if matcher else ""

    result.html_code = extract(HTML_PATTERN)
    result.css_code = extract(CSS_PATTERN)
    result.js_code = extract(JS_PATTERN)
    return result


def to_files(result: HtmlCodeResult | MultiFileCodeResult) -> dict[str, str]:

    files: dict[str, str] = {}
    if isinstance(result, HtmlCodeResult):
        if result.html_code:
            files["index.html"] = result.html_code
    elif isinstance(result, MultiFileCodeResult):
        if result.html_code:
            files["index.html"] = result.html_code
        if result.css_code:
            files["style.css"] = result.css_code
        if result.js_code:
            files["script.js"] = result.js_code
    return files
