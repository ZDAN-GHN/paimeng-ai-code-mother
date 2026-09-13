# paimeng-ai-code-rag

Python RAG 服务的 P4 骨架。当前目录保留退役 Python Agent 的代码以供后续精简复用，不参与过渡期代码生成链路，也不会修改 `python-agent.enabled`。

## 本地环境

```bash
uv sync
uv run pytest
# P4 实施后才启动服务：
uv run uvicorn app.main:app --port 8091
```
