const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 }
});

// ── Initialize Supabase ──
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';

if (!supabaseUrl) {
    console.error("⚠️  WARNING: SUPABASE_URL is missing!");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ── EasyOCR Python Service URL ──
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:5001';

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
    let ocrStatus = 'unknown';
    try {
        const r = await fetch(`${OCR_SERVICE_URL}/health`, { timeout: 3000 });
        const d = await r.json();
        ocrStatus = d.status === 'ok' ? 'online' : 'error';
    } catch {
        ocrStatus = 'offline';
    }
    res.json({
        status: 'ok',
        message: 'WiFi Report Backend — Supabase + EasyOCR',
        supabase: supabaseUrl ? 'configured' : 'missing',
        ocr_service: ocrStatus
    });
});

// ── วิเคราะห์สัญญาณด้วย EasyOCR Python Service ──
app.post('/api/analyze-signal', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'ไม่พบไฟล์ภาพ' });
        }

        // ส่งภาพไปยัง EasyOCR Python microservice
        const formData = new FormData();
        formData.append('image', req.file.buffer, {
            filename: req.file.originalname || 'image.jpg',
            contentType: req.file.mimetype
        });

        const ocrResponse = await fetch(`${OCR_SERVICE_URL}/analyze`, {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders(),
            timeout: 30000
        });

        if (!ocrResponse.ok) {
            throw new Error(`OCR service returned ${ocrResponse.status}`);
        }

        const data = await ocrResponse.json();

        if (!data.success) {
            return res.json({ success: false, error: data.error || 'OCR วิเคราะห์ไม่สำเร็จ' });
        }

        const signal = parseInt(data.signal_level);
        if (isNaN(signal) || signal < 1 || signal > 4) {
            return res.json({ success: false, error: 'ไม่พบระดับสัญญาณในภาพ กรุณาถ่ายให้ชัดขึ้น' });
        }

        res.json({
            success: true,
            signal_level: signal,
            ai_method: 'EasyOCR',
            ocr_text: data.ocr_text || '',
            detail: data
        });

    } catch (err) {
        console.error('[analyze-signal] Error:', err.message);

        // Fallback: ถ้า OCR service ล่ม ให้ใช้ Gemini (ถ้ามี key)
        if (process.env.GEMINI_API_KEY) {
            try {
                const { GoogleGenerativeAI } = require('@google/generative-ai');
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });
                const imagePart = {
                    inlineData: {
                        data: req.file.buffer.toString('base64'),
                        mimeType: req.file.mimetype
                    }
                };
                const prompt = `วิเคราะห์ภาพนี้หาไอคอนสัญญาณ WiFi หรือ 4G/5G แล้วตอบเป็นตัวเลข 1-4 เพียงตัวเดียว (1=อ่อนมาก 4=เต็ม) ถ้าไม่พบตอบ 0`;
                const result = await model.generateContent([prompt, imagePart]);
                const level = parseInt(result.response.text().trim());
                if (!isNaN(level) && level >= 1 && level <= 4) {
                    return res.json({ success: true, signal_level: level, ai_method: 'Gemini-Fallback' });
                }
            } catch (geminiErr) {
                console.error('[Gemini fallback] Error:', geminiErr.message);
            }
        }

        res.json({ success: false, error: 'ระบบ OCR ไม่พร้อมใช้งาน กรุณาลองใหม่: ' + err.message });
    }
});

// ── Submit Report ──
app.post('/api/submit', upload.single('image'), async (req, res) => {
    try {
        const { student_id, fullname, location, room, problem, signal, details } = req.body;
        let imageUrl = null;

        if (req.file) {
            const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
            const fileName = `uploads/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
            const { error: uploadError } = await supabase.storage
                .from('wifi_images')
                .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

            if (!uploadError) {
                const { data } = supabase.storage.from('wifi_images').getPublicUrl(fileName);
                imageUrl = data.publicUrl;
            }
        }

        const username = `${student_id || 'ไม่ระบุ'} - ${fullname || 'ไม่ระบุ'}`;
        const { error: dbError } = await supabase.from('wifi_reports').insert([{
            username,
            location: location || '-',
            room: room || '-',
            problem: problem || 'พบปัญหาจากภาพถ่าย',
            signal_level: parseInt(signal) || 0,
            details: details || '-',
            image_url: imageUrl
        }]);

        if (dbError) throw dbError;
        res.json({ success: true, image_url: imageUrl, message: 'บันทึกข้อมูลสำเร็จ' });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Issues CRUD ──
app.get('/api/issues', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('wifi_reports')
            .select('*')
            .neq('status', 'deleted')
            .order('id', { ascending: false });
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/issues/all', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('wifi_reports')
            .select('*')
            .order('id', { ascending: false });
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/issues/:id/status', async (req, res) => {
    try {
        const { error } = await supabase
            .from('wifi_reports')
            .update({ status: req.body.status })
            .eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/issues/:id', async (req, res) => {
    try {
        const { error } = await supabase
            .from('wifi_reports')
            .update({ status: 'deleted' })
            .eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/reset', async (req, res) => {
    try {
        const { error } = await supabase.from('wifi_reports').insert([{
            username: 'SYSTEM',
            location: 'SYSTEM_RESET',
            room: '-',
            problem: 'RESET',
            signal_level: 0,
            details: new Date().toISOString()
        }]);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clear-all', async (req, res) => {
    try {
        const { error } = await supabase
            .from('wifi_reports')
            .update({ status: 'deleted' })
            .neq('status', 'deleted');
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Stats endpoint สำหรับ Admin ──
app.get('/api/stats', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('wifi_reports')
            .select('*')
            .neq('status', 'deleted')
            .neq('location', 'SYSTEM_RESET');
        if (error) throw error;

        const issues = data || [];
        const total = issues.length;
        const resolved = issues.filter(i => i.status === 'resolved').length;
        const pending = total - resolved;
        const avgSignal = total > 0
            ? (issues.reduce((sum, i) => sum + (parseInt(i.signal_level) || 0), 0) / total).toFixed(1)
            : 0;

        // นับตามอาคาร
        const byLocation = {};
        issues.forEach(i => {
            if (!byLocation[i.location]) byLocation[i.location] = { total: 0, signals: [] };
            byLocation[i.location].total++;
            byLocation[i.location].signals.push(parseInt(i.signal_level) || 0);
        });

        const locationStats = Object.entries(byLocation).map(([loc, stat]) => ({
            location: loc,
            total: stat.total,
            avgSignal: (stat.signals.reduce((a, b) => a + b, 0) / stat.signals.length).toFixed(1),
            weakCount: stat.signals.filter(s => s <= 2).length
        })).sort((a, b) => b.total - a.total);

        res.json({
            total, resolved, pending, avgSignal,
            locationStats,
            recentIssues: issues.slice(0, 10)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
    console.log(`🚀 WiFi Report Server รันที่ port ${port}`);
    console.log(`🔗 OCR Service URL: ${OCR_SERVICE_URL}`);
});
