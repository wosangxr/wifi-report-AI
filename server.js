const path = require('path');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const vision = require('@google-cloud/vision');

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

let visionClient;
try {
    visionClient = new vision.ImageAnnotatorClient();
    console.log('✅ Cloud Vision AI client initialized');
} catch (err) {
    console.warn('⚠️  Cloud Vision AI not available:', err.message);
}

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
        message: 'WiFi Report AI Backend — Supabase + Cloud Vision',
        supabase: process.env.SUPABASE_URL ? 'configured' : 'missing',
        vision_ai: visionClient ? 'ready' : 'fallback'
    });
});

app.post('/api/analyze-signal', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No image provided' });

        let signalLevel = 0;
        let aiMethod = 'none';

        if (visionClient) {
            const [visionResult] = await visionClient.annotateImage({
                image: { content: req.file.buffer.toString('base64') },
                features: [
                    { type: 'TEXT_DETECTION' },
                    { type: 'LABEL_DETECTION', maxResults: 20 },
                    { type: 'OBJECT_LOCALIZATION', maxResults: 20 }
                ]
            });

            const textAnnotations = visionResult.textAnnotations || [];
            if (textAnnotations.length > 0) {
                const fullText = textAnnotations[0].description || '';
                const parsed = parseSignalFromText(fullText);
                if (parsed > 0) { signalLevel = parsed; aiMethod = 'OCR'; }
            }

            if (signalLevel === 0) {
                const labels = visionResult.labelAnnotations || [];
                const parsed = parseSignalFromLabels(labels);
                if (parsed > 0) { signalLevel = parsed; aiMethod = 'Label'; }
            }

            if (signalLevel === 0) {
                const objects = visionResult.localizedObjectAnnotations || [];
                const parsed = parseSignalFromObjects(objects);
                if (parsed > 0) { signalLevel = parsed; aiMethod = 'Object'; }
            }
        }

        if (signalLevel === 0) {
            return res.json({ success: false, error: 'AI วิเคราะห์ไม่พบระดับสัญญาณ 4G/5G หรือ WiFi โปรดลองภาพที่ชัดเจนขึ้น' });
        }

        res.json({ success: true, signal_level: signalLevel, ai_method: aiMethod });
    } catch (err) {
        res.json({ success: false, error: 'เกิดข้อผิดพลาดจาก AI: ' + err.message });
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

function parseSignalFromText(text) {
    if (!text) return 0;
    const fractionMatch = text.match(/\b([1-4])\/[4-5]\b/);
    if (fractionMatch) return parseInt(fractionMatch[1]);
    const barMatch = text.match(/\b([1-4])\s*(bar|bars|ขีด|สัญญาณ|signal)/i);
    if (barMatch) return parseInt(barMatch[1]);
    const dbmMatch = text.match(/-(\d{2,3})\s*d[Bb][Mm]/);
    if (dbmMatch) {
        const dbm = parseInt(dbmMatch[1]);
        if (dbm <= 50) return 4;
        if (dbm <= 60) return 3;
        if (dbm <= 70) return 2;
        return 1;
    }
    return 0;
}

function parseSignalFromLabels(labels) {
    if (!labels || labels.length === 0) return 0;
    const names = labels.map(l => (l.description || '').toLowerCase());
    const hasWifi = names.some(n => n.includes('signal') || n.includes('wifi') || n.includes('wireless') || n.includes('reception'));
    if (!hasWifi) return 0;
    if (names.some(n => n.includes('weak') || n.includes('low') || n.includes('poor'))) return 1;
    if (names.some(n => n.includes('strong') || n.includes('full') || n.includes('excellent'))) return 4;
    return 2;
}

function parseSignalFromObjects(objects) {
    const bars = objects.filter(obj => {
        const name = (obj.name || '').toLowerCase();
        return obj.score > 0.5 && (name.includes('bar') || name.includes('column') || name.includes('rectangle'));
    });
    if (bars.length >= 1 && bars.length <= 4) return bars.length;
    return 0;
}

const port = process.env.PORT || 8080; 
app.listen(port, () => {
    console.log(`🚀 Server is running on port ${port}`);
});
