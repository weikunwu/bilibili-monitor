FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt Pillow

COPY monitor.py .
COPY static/ static/

EXPOSE 8080

CMD ["sh", "-c", "python monitor.py --rooms \"${ROOMS:-1920456329,32365569}\" --port 8080"]
