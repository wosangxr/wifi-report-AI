const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

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

// ── Python AI API URL ──
const AI_API_URL = process.env.AI_API_URL || 'http://localhost:5000';

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
app.get('/api/health', async (req, res) => {
    let aiStatus = 'disconnected';
    try {
        const aiRes = await fetch(`${AI_API_URL}/api/health`);
        if (aiRes.ok) aiStatus = 'connected';
    } catch (_) {}
    res.json({
        status: 'ok',
        message: 'WiFi Report AI Backend — Supabase + EasyOCR + OpenCV',
        supabase: process.env.SUPABASE_URL ? 'configured' : 'missing',
        ai_api: aiStatus,
        ai_url: AI_API_URL
    });
});

app.post('/api/analyze-signal', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No image provided' });
        }

        // ส่งรูปไปยัง Python AI API (EasyOCR + OpenCV)
        const formData = new FormData();
        const file = new File([req.file.buffer], req.file.originalname || 'image.jpg', { type: req.file.mimetype });
        formData.append('image', file);

        const aiResponse = await fetch(`${AI_API_URL}/api/analyze`, {
            method: 'POST',
            body: formData
        });

        const data = await aiResponse.json();
        console.log(`[AI API] Response:`, data);

        if (!data.success) {
            return res.json({ success: false, error: data.error || 'AI วิเคราะห์ไม่สำเร็จ' });
        }

        // แปลง signal_strength (1-5) → signal_level เพื่อให้ frontend ใช้งานได้
        res.json({
            success: true,
            signal_level: data.signal_strength,
            network: data.network || 'unknown',
            ai_method: data.ai_method || 'EasyOCR + OpenCV'
        });

    } catch (err) {
        console.error('AI API Error:', err);

        let errorMsg = 'ไม่สามารถเชื่อมต่อ AI API ได้';
        if (err.cause?.code === 'ECONNREFUSED') {
            errorMsg = 'Python AI API ไม่ทำงาน กรุณาตรวจสอบว่า Flask server รันอยู่';
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
    console.log(`🤖 AI API URL: ${AI_API_URL}`);
});