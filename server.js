const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 }
});

// ── Initialize Clients ──
const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || 'placeholder';

if (supabaseUrl === 'https://placeholder.supabase.co') {
    console.error("⚠️ WARNING: SUPABASE_URL is missing! Please set Environment Variables in Cloud Run.");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ── Initialize Gemini AI ──
const geminiApiKey = process.env.GEMINI_API_KEY || 'ใส่_API_KEY_ของคุณที่นี่';
const genAI = new GoogleGenerativeAI(geminiApiKey);

// ── Middlewares ──
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ============================================================
// API Routes
// ============================================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'WiFi Report AI Backend — Supabase + Gemini AI',
        supabase: process.env.SUPABASE_URL ? 'configured' : 'missing',
        gemini_key: geminiApiKey !== 'ใส่_API_KEY_ของคุณที่นี่' ? 'configured' : 'MISSING',
        vision_ai: 'gemini-ready'
    });
});

app.post('/api/analyze-signal', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No image provided' });
        }

        if (!geminiApiKey || geminiApiKey === 'ใส่_API_KEY_ของคุณที่นี่') {
            return res.json({ success: false, error: 'GEMINI_API_KEY ขาดหาย! กรุณาตั้งค่าในไฟล์โค้ดหรือใน Cloud Run' });
        }

        // ✅ เปลี่ยนมาใช้ flash เพื่อให้โหลดเร็วและไม่ติด Error 404
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const imagePart = {
            inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: req.file.mimetype
            },
        };

        // ✅ ปรับ Prompt ให้ครอบคลุมทั้ง WiFi และ 4G/5G/LTE
        const prompt = `Look at this screenshot carefully.

Find the WiFi signal icon (can be curved waves/arcs or vertical bars) OR mobile data signal (4G/5G/LTE vertical bars).
Count how many levels/divisions are filled or active.

Rules:
- Full signal (4 waves/bars filled) → reply: 4
- 3 waves/bars filled → reply: 3
- 2 waves/bars filled → reply: 2
- 1 wave/bar filled → reply: 1
- No signal icon found or 0 filled → reply: 0

IMPORTANT: Reply with a SINGLE digit only (0, 1, 2, 3, or 4). No other text.`;

        const result = await model.generateContent([prompt, imagePart]);
        const responseText = result.response.text().trim();

        console.log(`[Gemini] Raw response: "${responseText}"`);

        const match = responseText.match(/[0-4]/);
        const signalLevel = match ? parseInt(match[0]) : 0;

        if (isNaN(signalLevel) || signalLevel === 0) {
            return res.json({
                success: false,
                error: 'AI วิเคราะห์ไม่พบระดับสัญญาณจากภาพนี้ กรุณาถ่ายรูปให้เห็นไอคอนชัดเจน'
            });
        }

        res.json({ success: true, signal_level: signalLevel, ai_method: 'Gemini Vision' });

    } catch (err) {
        console.error("AI Error:", err);

        let errorMsg = 'เกิดข้อผิดพลาดจาก AI';
        if (err.message?.includes('API_KEY_INVALID') || err.message?.includes('API key')) {
            errorMsg = 'GEMINI_API_KEY ไม่ถูกต้อง กรุณาตรวจสอบให้แน่ใจว่าคีย์ใช้งานได้';
        } else if (err.message?.includes('quota') || err.message?.includes('QUOTA')) {
            errorMsg = 'API quota หมดแล้ว กรุณาลองใหม่ภายหลัง';
        } else if (err.message?.includes('not found') || err.message?.includes('404')) {
            errorMsg = 'ชื่อ model ไม่ถูกต้อง หรือการเชื่อมต่อมีปัญหา';
        } else {
            errorMsg = 'เกิดข้อผิดพลาด: ' + err.message;
        }

        res.json({ success: false, error: errorMsg });
    }
});

app.post('/api/submit', upload.single('image'), async (req, res) => {
    try {
        const { student_id, fullname, location, room, problem, signal, details } = req.body;
        let imageUrl = null;

        if (req.file) {
            const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
            const fileName = `uploads/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

            const { data: uploadData, error: uploadError } = await supabase.storage
                .from('wifi_images')
                .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

            if (!uploadError) {
                const { data } = supabase.storage.from('wifi_images').getPublicUrl(fileName);
                imageUrl = data.publicUrl;
            }
        }

        const username = `${student_id || 'ไม่ระบุ'} - ${fullname || 'ไม่ระบุ'}`;
        const { error: dbError } = await supabase.from('wifi_reports').insert([{
            username, location: location || '-', room: room || '-',
            problem: problem || 'พบปัญหาจากภาพถ่าย', signal_level: parseInt(signal) || 0,
            details: details || '-', image_url: imageUrl
        }]);

        if (dbError) throw dbError;
        res.json({ success: true, image_url: imageUrl, message: 'บันทึกข้อมูลสำเร็จ' });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/issues', async (req, res) => {
    try {
        const { data, error } = await supabase.from('wifi_reports').select('*').neq('status', 'deleted').order('id', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/issues/all', async (req, res) => {
    try {
        const { data, error } = await supabase.from('wifi_reports').select('*').order('id', { ascending: false });
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/issues/:id/status', async (req, res) => {
    try {
        const { error } = await supabase.from('wifi_reports').update({ status: req.body.status }).eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/issues/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('wifi_reports').update({ status: 'deleted' }).eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/reset', async (req, res) => {
    try {
        const { error } = await supabase.from('wifi_reports').insert([{
            username: 'SYSTEM', location: 'SYSTEM_RESET', room: '-', problem: 'RESET', signal_level: 0, details: new Date().toISOString()
        }]);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clear-all', async (req, res) => {
    try {
        const { error } = await supabase.from('wifi_reports').update({ status: 'deleted' }).neq('status', 'deleted');
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
    console.log(`🚀 Server is running on port ${port}`);
    console.log(`🔑 Gemini API Key: ${geminiApiKey !== 'ใส่_API_KEY_ของคุณที่นี่' ? 'SET ✅' : 'MISSING ❌'}`);
});