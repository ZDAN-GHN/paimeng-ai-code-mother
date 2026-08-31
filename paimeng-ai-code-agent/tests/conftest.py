"""测试公共配置：在导入 app 前注入环境变量。"""

import os

os.environ.setdefault("PYTHON_AGENT_TOKEN", "test-token")
os.environ.setdefault("WORKSPACE_ROOT", "/tmp/paimeng-test-workspace")
os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/paimeng_test")
