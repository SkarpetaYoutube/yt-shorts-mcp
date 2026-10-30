FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.lock .
RUN pip install -r requirements.lock

# Tylko kod aplikacji — żadnych plików .env ani kluczy w obrazie.
COPY common.py youtube_mcp.py supadata_mcp.py collect.py server.py ./

EXPOSE 8080
CMD ["python", "server.py"]
