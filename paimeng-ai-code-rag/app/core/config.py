"""Python Agent 全局配置（pydantic-settings，读取 .env / 环境变量）。"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# 仓库根目录：app/core/config.py 上溯四级到 paimeng-ai-code-agent 的上一级
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent

# .env 绝对路径，避免依赖进程工作目录（PyCharm 等 IDE 启动时 cwd 不在 agent 目录会导致 .env 读不到）
_ENV_FILE = _REPO_ROOT / "paimeng-ai-code-agent" / ".env"


class Settings(BaseSettings):
    """Python Agent 全局配置。

    .env 键名与 docs/py_agent/task_plan.md §9 保持一致；
    Java↔Python 令牌两端共享（Java 侧 python-agent.token 同值）。
    """

    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    # 内部调用令牌（与 Java 侧 python-agent.token 一致），缺失时所有内部接口返回 401
    python_agent_token: str = ""

    # 工作区根目录：与 Java 侧 AppConstant.CODE_OUTPUT_ROOT_DIR（仓库 runtime/tmp/code_output）为同一绝对路径
    workspace_root: Path = _REPO_ROOT / "tmp" / "code_output"

    # PostgreSQL DSN，仅用于 LangGraph checkpoint
    database_url: str = "postgresql://postgres:postgres@localhost:5432/paimeng"

    # Java 后端地址（完成回调目标；注意 Java context-path 为 /api）
    java_base_url: str = "http://localhost:8123"

    # 模型配置（DeepSeek，OpenAI 兼容规范）
    model_base_url: str = "https://api.deepseek.com"
    model_api_key: str = ""
    model_name: str = "deepseek-chat"
    reasoning_model_name: str = "deepseek-reasoner"

    # 阿里云 DashScope（图片生成）
    dashscope_api_key: str = ""
    image_model: str = "wan2.2-t2i-flash"

    # Pexels（内容图片搜索，与 Java 侧 pexels.api-key 同值）
    pexels_api_key: str = ""

    # 主通道流式响应缓冲区大小（字节）
    sse_buffer_size: int = 1024


@lru_cache
def get_settings() -> Settings:
    """获取全局配置单例。"""
    return Settings()
