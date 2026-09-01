"""Python Agent 应用入口（FastAPI + Uvicorn）。"""

import uvicorn
from fastapi import FastAPI

from app.api.routes import router as agent_router

app = FastAPI(title="paimeng-ai-code-agent", version="0.1.0")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    """健康检查（§1.1）。"""
    return {"status": "ok"}


app.include_router(agent_router)


def run() -> None:
    """启动 Uvicorn 服务（0.0.0.0:8090，不开启热重载）。"""
    uvicorn.run("app.main:app", host="0.0.0.0", port=8090, reload=False)


if __name__ == "__main__":
    run()
