"""Python Agent 应用入口（FastAPI）。"""

from fastapi import FastAPI

from app.api.routes import router as agent_router

app = FastAPI(title="paimeng-ai-code-agent", version="0.1.0")


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    """健康检查（§1.1）。"""
    return {"status": "ok"}


app.include_router(agent_router)
