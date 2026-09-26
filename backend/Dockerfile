FROM python:3.12-slim AS base

FROM base AS dependencies
COPY --from=ghcr.io/astral-sh/uv:0.12.12 /uv /bin/uv
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN UV_COMPILE_BYTECODE=1 uv sync --frozen --no-dev

FROM base AS assets
COPY assets/preferences/ /assets/preferences/
# 与前端素材层一样固定时间，避免干净检出产生的新时间进入素材层摘要。
RUN find /assets -type f -exec chmod 644 {} + \
    && find /assets -type d -exec chmod 755 {} + \
    && find /assets -exec touch -h -d @0 {} +

FROM base
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ASSET_MANIFEST_PATH=/app/assets/resource-manifest.json PREFERENCE_ASSET_ROOT=/app/assets/preferences PREFERENCE_MANIFEST_PATH=/app/assets/preferences-manifest.json
# 小规模数值归约不需要多核 BLAS，默认保留 CPU 给网页请求。
ENV OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
RUN groupadd --gid 10001 atlas && useradd --uid 10001 --gid 10001 --create-home atlas \
    && mkdir -p staticfiles && chown atlas:atlas staticfiles
# 复制时设置归属，避免末尾 chown -R 再生成包含全部素材的大层。
COPY --link --chown=10001:10001 --from=dependencies /app/.venv/ ./.venv/
COPY --link --chown=10001:10001 --from=assets /assets/preferences/ ./assets/preferences/
COPY --link --chown=10001:10001 assets/resource-manifest.json assets/preferences-manifest.json ./assets/
COPY --link --chown=10001:10001 data/preferences/ ./data/preferences/
COPY --link --chown=10001:10001 backend/ ./
USER atlas
# 迁移、缓存表、静态文件收集和资料发布由维护者显式执行。
# 不记录查询字符串，避免后台搜索和旧账号链接进入访问日志。
CMD [".venv/bin/gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "90", "--access-logfile", "-", "--access-logformat", "%(h)s %(m)s %(U)s %(s)s %(L)s"]
