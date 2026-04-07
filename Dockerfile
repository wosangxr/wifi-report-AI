FROM node:20-slim

# 1. ติดตั้ง Python และ Library พื้นฐานที่ OpenCV/EasyOCR ต้องใช้ให้ครบ
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    libgl1 libglib2.0-0 libsm6 libxext6 libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. จัดการ Python venv และติดตั้ง dependencies
COPY python-api/requirements.txt ./python-api/requirements.txt
RUN python3 -m venv /app/venv && \
    /app/venv/bin/pip install --no-cache-dir -r python-api/requirements.txt

# --- จุดสำคัญ: สั่งให้โหลดโมเดล AI ไว้ใน Image ตั้งแต่ตอน Build ---
# วิธีนี้จะช่วยแก้ปัญหา Error 8080 เพราะไม่ต้องรอโหลดตอนรันเว็บ
RUN /app/venv/bin/python3 -c "import easyocr; reader = easyocr.Reader(['en'], gpu=False)"

# 3. ติดตั้ง Node.js dependencies
COPY package*.json ./
RUN npm install

# 4. Copy โค้ดทั้งหมด
COPY . .

# 5. ตั้งค่าสิทธิ์และพอร์ต
RUN chmod +x start.sh || true
EXPOSE 8080

# กำหนดตัวแปรสภาพแวดล้อมให้ Python รู้ว่าจะใช้พอร์ตไหน (ถ้าจำเป็น)
ENV PORT=8080

CMD ["./start.sh"]
