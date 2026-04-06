#!/bin/bash

echo "🐍 Starting Python AI API..."
/app/venv/bin/python /app/python-api/app.py &

# รอให้ Python API พร้อม
sleep 3

echo "🚀 Starting Node.js server..."
node /app/server.js
