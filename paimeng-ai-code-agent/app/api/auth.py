"""内部接口鉴权：Bearer 令牌校验。"""

from fastapi import Header, HTTPException

from app.core.config import get_settings


async def require_bearer_token(authorization: str = Header(default="")) -> str:
    """校验 Bearer 令牌，缺失/错误返回 401。

    令牌与 Java 侧 python-agent.token 共享同一值（§1.1）。

    :param authorization: Authorization 请求头
    :return: 合法令牌
    """
    settings = get_settings()
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")
    token = authorization.removeprefix("Bearer ").strip()
    if not token or token != settings.python_agent_token:
        raise HTTPException(status_code=401, detail="unauthorized")
    return token
