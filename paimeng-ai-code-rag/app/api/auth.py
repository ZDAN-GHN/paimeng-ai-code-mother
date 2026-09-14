from fastapi import Header, HTTPException

from app.core.config import get_settings


async def require_bearer_token(authorization: str = Header(default="")) -> str:

    settings = get_settings()
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")
    token = authorization.removeprefix("Bearer ").strip()
    if not token or token != settings.python_agent_token:
        raise HTTPException(status_code=401, detail="unauthorized")
    return token
