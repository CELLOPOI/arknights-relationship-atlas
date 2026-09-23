FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.12 /uv /bin/uv
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 ASSET_MANIFEST_PATH=/app/assets/resource-manifest.json PREFERENCE_ASSET_ROOT=/app/assets/preferences PREFERENCE_MANIFEST_PATH=/app/assets/preferences-manifest.json
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev
COPY backend/ ./
COPY assets/resource-manifest.json ./assets/resource-manifest.json
COPY assets/preferences-manifest.json ./assets/preferences-manifest.json
COPY assets/preferences/ ./assets/preferences/
COPY data/preferences/ ./data/preferences/
RUN groupadd --gid 10001 atlas && useradd --uid 10001 --gid 10001 --create-home atlas && mkdir -p staticfiles && chown -R atlas:atlas /app
USER atlas
# 迁移、缓存表、静态文件收集和资料发布由维护者显式执行。
# 不记录查询字符串，避免后台搜索和旧账号链接进入访问日志。
CMD [".venv/bin/gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "90", "--access-logfile", "-", "--access-logformat", "%(h)s %(m)s %(U)s %(s)s %(L)s"]
