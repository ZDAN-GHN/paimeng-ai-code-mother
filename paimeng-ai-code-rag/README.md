# paimeng-ai-code-rag

Python RAG 服务的 P4 骨架。当前目录保留退役 Python Agent 的代码以供后续精简复用，不参与过渡期代码生成链路，也不会修改 `python-agent.enabled`。

## WSL 环境

```bash
bash scripts/install-wsl-venv.sh
bash scripts/run-wsl.sh test
# P4 实施后才启动服务：
bash scripts/run-wsl.sh serve
```

脚本通过 `UV_PROJECT_ENVIRONMENT`、`UV_CACHE_DIR` 和 `UV_PYTHON_INSTALL_DIR` 将 WSL 虚拟环境、缓存与 uv 管理的 Python 放到 `../wsl-rt-env/python/`。

## Windows / IDE

Windows 继续按 uv 默认规则在本目录使用 `.venv`：

```powershell
uv sync
uv run pytest
```

无需修改 IDE 的 Python 解释器或运行配置；首次安装仅会创建 Windows 平台专用的本地 `.venv`。
