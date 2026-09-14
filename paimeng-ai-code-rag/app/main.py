

import uvicorn
from fastapi import FastAPI

from app.api.routes import router as agent_router

app = FastAPI(title="paimeng-ai-code-agent", version="0.1.0")


@app.get("/healthz")
async def healthz() -> dict[str, str]:

    return {"status": "ok"}


app.include_router(agent_router)


def run() -> None:

    uvicorn.run("app.main:app", host="0.0.0.0", port=8090, reload=False)


if __name__ == "__main__":
    run()
