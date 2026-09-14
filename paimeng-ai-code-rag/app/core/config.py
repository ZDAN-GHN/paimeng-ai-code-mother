from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_ENV_FILE = _REPO_ROOT / "paimeng-ai-code-agent" / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE, env_file_encoding="utf-8", extra="ignore"
    )
    python_agent_token: str = ""
    workspace_root: Path = _REPO_ROOT / "tmp" / "code_output"
    database_url: str = "postgresql://postgres:postgres@localhost:5432/paimeng"
    java_base_url: str = "http://localhost:8123"
    model_base_url: str = "https://api.deepseek.com"
    model_api_key: str = ""
    model_name: str = "deepseek-chat"
    reasoning_model_name: str = "deepseek-reasoner"
    dashscope_api_key: str = ""
    image_model: str = "wan2.2-t2i-flash"
    pexels_api_key: str = ""
    sse_buffer_size: int = 1024


@lru_cache
def get_settings() -> Settings:

    return Settings()
