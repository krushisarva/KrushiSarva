# KrushiSarva AI service: one image for both the FastAPI web process and the
# Celery worker. The worker overrides CMD in deploy/docker-compose.yml.
#
# Railway built this folder with Nixpacks (fastapi/railway.json); this file is
# for the single-VPS deploy (docs/deploy/VPS_DEPLOY_PLAN.md §5.3). No ML
# runtimes: every pinned dependency in requirements.txt ships a wheel.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first, for layer caching.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Run unprivileged.
RUN useradd --system --uid 10001 app && chown -R app:app /app
USER app

EXPOSE 8001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1", "--no-access-log"]
