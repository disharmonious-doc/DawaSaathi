FROM python:3.13-slim
WORKDIR /app
COPY dawasaathi-v7/ .
ENV HOST=0.0.0.0
CMD ["python3", "server.py"]
