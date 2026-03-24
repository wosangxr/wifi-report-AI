require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const axios = require('axios');

// ==========================================
// 1. App Configuration & Initialization
// ==========================================
const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname)); // Serve frontend files

// ==========================================
// 2. Database Configuration
// ==========================================
const dbConfig = {
    user: process.env.DB_USER || "sa",
    password: process.env.DB_PASSWORD || "123456789",
    server: process.env.DB_SERVER || "localhost",
    database: process.env.DB_DATABASE || "wifi_issues",
    options: {
        encrypt: false, // Set to true if using Azure
        trustServerCertificate: true // Trust local certificates
    }
};

// Initial Database Connection Check
console.log('--- Database Configuration ---');
console.log('Server:', dbConfig.server);
console.log('User:', dbConfig.user);
console.log('Database:', dbConfig.database);
console.log('------------------------------');

sql.connect(dbConfig).then(pool => {
    if (pool.connected) {
        console.log('✅ Connected to SQL Server successfully!');
    }
}).catch(err => {
    console.error('❌ SQL Connection Error:', err.message);
    console.log('TIP: Check if TCP/IP is enabled and SQL Server is running.');
});

// ==========================================
// 3. API Routes
// ==========================================

// --- Health Check ---
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', msg: 'API is running' });
});

// --- Setup Database Table (Optional Utility) ---
app.get('/api/setup-db', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        await pool.query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='wifi_reports' AND xtype='U')
            BEGIN
                CREATE TABLE wifi_reports (
                    id INT IDENTITY(1,1) PRIMARY KEY,
                    username NVARCHAR(100),
                    location NVARCHAR(100),
                    room NVARCHAR(50),
                    problem NVARCHAR(100),
                    signal_level INT,
                    details NVARCHAR(MAX),
                    status NVARCHAR(20) DEFAULT 'pending',
                    created_at DATETIME DEFAULT GETDATE()
                );
            END
        `);
        res.send(`✅ Table [wifi_reports] checked/created successfully!<br><br>Go back to <a href="http://localhost:${PORT}">http://localhost:${PORT}</a> to use the app.`);
    } catch (err) {
        console.error('Database Setup Error:', err);
        res.status(500).send(`❌ Error connecting to Database: ${err.message}<br><br>Make sure DB_USER, DB_PASSWORD, and DB_DATABASE exist in your SQL Server.`);
    }
});

// --- Get All Issues ---
app.get('/api/issues', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.query('SELECT * FROM wifi_reports ORDER BY id DESC');
        
        // Map records for frontend consumption
        const mappedRecords = result.recordset.map(record => {
            let student_id = "ไม่ระบุ";
            let fullname = record.username || "ไม่ระบุ";
            
            // Extract student_id and fullname if stored as "ID - Name"
            if (record.username && record.username.includes(" - ")) {
                const parts = record.username.split(" - ");
                student_id = parts[0];
                fullname = parts[1];
            }
            
            return {
                id: record.id,
                student_id: student_id,
                fullname: fullname,
                location: record.location,
                room: record.room,
                problem: record.problem,
                signal: record.signal_level,
                details: record.details,
                status: record.status,
                created_at: record.created_at
            };
        });
        
        res.json(mappedRecords);
    } catch (err) {
        console.error('Fetch issues error:', err);
        res.status(500).json({ error: 'Database fetch error' });
    }
});

// --- Create New Issue ---
app.post('/api/issues', async (req, res) => {
    try {
        const { student_id, fullname, location, room, problem, signal, details } = req.body;
        const pool = await sql.connect(dbConfig);
        
        const username = `${student_id || 'ไม่ระบุ'} - ${fullname || 'ไม่ระบุ'}`;

        await pool.request()
            .input('username', sql.NVarChar, username)
            .input('location', sql.NVarChar, location || '-')
            .input('room', sql.NVarChar, room || '-')
            .input('problem', sql.NVarChar, problem || '-')
            .input('signal_level', sql.Int, signal || 0)
            .input('details', sql.NVarChar, details || '-')
            .query(`
                INSERT INTO wifi_reports (username, location, room, problem, signal_level, details) 
                VALUES (@username, @location, @room, @problem, @signal_level, @details)
            `);

        // Trigger Line Notify asynchronously (non-blocking)
        if (process.env.LINE_NOTIFY_TOKEN && process.env.LINE_NOTIFY_TOKEN !== 'YOUR_LINE_NOTIFY_TOKEN_HERE') {
            const message = `\n🚨 แจ้งปัญหา WiFi 🚨\n📍 สถานที่: ${location}\nห้อง: ${room}\nผู้แจ้ง: ${fullname} (${student_id})\nปัญหา: ${problem}\nสัญญาณ: ${signal} ขีด\nรายละเอียด: ${details || '-'}`;
            
            axios.post('https://notify-api.line.me/api/notify', new URLSearchParams({ message }), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Bearer ${process.env.LINE_NOTIFY_TOKEN}`
                }
            }).catch(e => console.error("Line Notify Error:", e.response?.data || e.message));
        }

        res.status(201).json({ success: true, message: 'Issue reported successfully' });
    } catch (err) {
        console.error('Create issue error:', err);
        res.status(500).json({ error: 'Database insert error' });
    }
});

// --- Update Issue Status ---
app.put('/api/issues/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('id', sql.Int, id)
            .input('status', sql.NVarChar, status)
            .query('UPDATE wifi_reports SET status = @status WHERE id = @id');
            
        res.json({ success: true, message: `Status updated to ${status}` });
    } catch (err) {
        console.error('Update status error:', err);
        res.status(500).json({ error: 'Database update error' });
    }
});

// --- Delete Issue ---
app.delete('/api/issues/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM wifi_reports WHERE id = @id');
            
        res.json({ success: true, message: 'Issue deleted successfully' });
    } catch (err) {
        console.error('Delete issue error:', err);
        res.status(500).json({ error: 'Database delete error' });
    }
});

// ==========================================
// 4. Server Listener
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
});