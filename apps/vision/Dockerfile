FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 VISION_MODEL_DIR=/models
WORKDIR /app
COPY apps/vision/requirements.txt ./requirements.txt
RUN pip install --no-compile --no-cache-dir -r requirements.txt
COPY apps/vision/server.py ./server.py
USER 65534:65534
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "16"]
