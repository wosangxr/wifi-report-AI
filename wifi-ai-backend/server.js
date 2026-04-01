const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const vision = require('@google-cloud/vision');

const app = express();

// File upload handler - keep image in memory
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});

// ── Initialize Clients ──
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

let visionClient;
try {
    visionClient = new vision.ImageAnnotatorClient();
    console.log('✅ Cloud Vision AI client initialized');
} catch (err) {
    console.warn('⚠️  Cloud Vision AI not available:', err.message);
    console.warn('   Image analysis will use fallback mode');
}

// ── Middlewares ──
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..'))); // Serve frontend files from parent folder

// ============================================================
// API Routes
// ============================================================

// Health Check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'WiFi Report AI Backend — Supabase + Cloud Vision',
        supabase: process.env.SUPABASE_URL,
        vision_ai: visionClient ? 'ready' : 'fallback'
    });
});

// ── POST /api/analyze-signal ──
// Receives image → runs Cloud Vision AI → returns signal level (no storage)
app.post('/api/analyze-signal', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No image provided' });
        }

        let signalLevel = 0;
        let aiMethod = 'none';

        if (visionClient) {
            // ── Run Cloud Vision AI ──
            const [visionResult] = await visionClient.annotateImage({
                image: { content: req.file.buffer.toString('base64') },
                features: [
                    { type: 'TEXT_DETECTION' },
                    { type: 'LABEL_DETECTION', maxResults: 20 },
                    { type: 'OBJECT_LOCALIZATION', maxResults: 20 }
                ]
            });

            // Method 1: Parse signal from OCR text
            const textAnnotations = visionResult.textAnnotations || [];
            if (textAnnotations.length > 0) {
                const fullText = textAnnotations[0].description || '';
                console.log(`📝 OCR: "${fullText.substring(0, 150).replace(/\n/g, ' ')}"`);
                const parsed = parseSignalFromText(fullText);
                if (parsed > 0) { signalLevel = parsed; aiMethod = 'OCR'; }
            }

            // Method 2: Parse from Vision labels
            if (signalLevel === 0) {
                const labels = visionResult.labelAnnotations || [];
                console.log(`🏷️  Labels: ${labels.slice(0, 5).map(l => l.description).join(', ')}`);
                const parsed = parseSignalFromLabels(labels);
                if (parsed > 0) { signalLevel = parsed; aiMethod = 'Label'; }
            }

            // Method 3: Count bar-like detected objects
            if (signalLevel === 0) {
                const objects = visionResult.localizedObjectAnnotations || [];
                const parsed = parseSignalFromObjects(objects);
                if (parsed > 0) { signalLevel = parsed; aiMethod = 'Object'; }
            }
        }

        // Fallback: default to 2 bars
        if (signalLevel === 0) {
            signalLevel = 2;
            aiMethod = visionClient ? 'default' : 'fallback';
        }

        console.log(`📶 Signal: ${signalLevel} bar(s) — detected by: ${aiMethod}`);

        res.json({
            success: true,
            signal_level: signalLevel,
            ai_method: aiMethod
        });

    } catch (err) {
        console.error('❌ /api/analyze-signal error:', err.message);
        // Return fallback instead of error so frontend still works
        res.json({
            success: true,
            signal_level: 2,
            ai_method: 'error-fallback'
        });
    }
});

// ── POST /api/submit ──
// Receives FormData (image + fields) → uploads image to Supabase Storage → saves record to DB
app.post('/api/submit', upload.single('image'), async (req, res) => {
    try {
        const { student_id, fullname, location, room, problem, signal, details } = req.body;
        let imageUrl = null;

        // ── Upload image to Supabase Storage ──
        if (req.file) {
            const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
            const fileName = `uploads/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

            const { data: uploadData, error: uploadError } = await supabase.storage
                .from('wifi_images')
                .upload(fileName, req.file.buffer, {
                    contentType: req.file.mimetype,
                    cacheControl: '31536000'
                });

            if (uploadError) {
                console.error('⚠️ Image upload error:', uploadError.message);
            } else {
                const { data } = supabase.storage.from('wifi_images').getPublicUrl(fileName);
                imageUrl = data.publicUrl;
                console.log(`✅ Image uploaded: ${imageUrl}`);
            }
        }

        // ── Save to Supabase DB ──
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

        res.json({
            success: true,
            image_url: imageUrl,
            message: 'บันทึกข้อมูลสำเร็จ'
        });

    } catch (err) {
        console.error('❌ /api/submit error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── GET /api/issues ──
app.get('/api/issues', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('wifi_reports')
            .select('*')
            .neq('status', 'deleted')
            .order('id', { ascending: false });

        if (error) throw error;

        const mapped = (data || []).map(r => {
            let student_id = 'ไม่ระบุ';
            let fullname = r.username || 'ไม่ระบุ';
            if (r.username && r.username.includes(' - ')) {
                [student_id, fullname] = r.username.split(' - ');
            }
            return {
                id: r.id, student_id, fullname,
                location: r.location, room: r.room,
                problem: r.problem, signal: r.signal_level,
                details: r.details, status: r.status,
                image_url: r.image_url, created_at: r.created_at
            };
        });

        res.json(mapped);
    } catch (err) {
        console.error('❌ /api/issues GET error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/issues/all (for dashboard — includes all non-deleted for ranking) ──
app.get('/api/issues/all', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('wifi_reports')
            .select('*')
            .order('id', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error('❌ /api/issues/all error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /api/issues/:id/status ──
app.put('/api/issues/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const { error } = await supabase.from('wifi_reports')
            .update({ status })
            .eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── DELETE /api/issues/:id (soft delete — mark as 'deleted') ──
app.delete('/api/issues/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('wifi_reports')
            .update({ status: 'deleted' })
            .eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/reset (insert SYSTEM_RESET marker) ──
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

// ── POST /api/clear-all (mark all as deleted for admin view) ──
app.post('/api/clear-all', async (req, res) => {
    try {
        const { error } = await supabase.from('wifi_reports')
            .update({ status: 'deleted' })
            .neq('status', 'deleted');
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Vision AI Helper Functions
// ============================================================

function parseSignalFromText(text) {
    if (!text) return 0;

    // Pattern: "2/4", "3/4", "1/4", "4/4"
    const fractionMatch = text.match(/\b([1-4])\/[4-5]\b/);
    if (fractionMatch) return parseInt(fractionMatch[1]);

    // Pattern: "2 bars", "3 ขีด", "Signal 1"
    const barMatch = text.match(/\b([1-4])\s*(bar|bars|ขีด|สัญญาณ|signal)/i);
    if (barMatch) return parseInt(barMatch[1]);

    // Pattern: dBm signal strength → convert to bars
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

// ============================================================
// Start Server
// ============================================================
// ให้ระบบใช้ PORT ของ Google Cloud หรือถ้ารันในคอมตัวเองให้ใช้ 8080
const port = process.env.PORT || 8080; 

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
