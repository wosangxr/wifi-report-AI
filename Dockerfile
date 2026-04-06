FROM node:20-slim

# ติดตั้ง Python + dependencies ที่ OpenCV/EasyOCR ต้องใช้
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ติดตั้ง Python dependencies ก่อน (cache layer)
COPY python-api/requirements.txt ./python-api/requirements.txt
RUN python3 -m venv /app/venv && \
    /app/venv/bin/pip install --no-cache-dir -r python-api/requirements.txt

# ติดตั้ง Node.js dependencies
COPY package*.json ./
RUN npm install

# Copy source code ทั้งหมด
COPY . .

EXPOSE 8080

# รัน Python AI API (port 5000) + Node.js server (port 8080) พร้อมกัน
COPY start.sh ./start.sh
RUN chmod +x start.sh
CMD ["./start.sh"]