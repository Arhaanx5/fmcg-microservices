import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import qrcode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const INTERNAL_SECRET = process.env.WA_INTERNAL_SECRET || process.env.INTERNAL_SECRET || 'fmcg_secret_9450480_key';
const QUEUE_FILE = path.join(process.cwd(), 'queue.json');
const DEAD_LETTER_FILE = path.join(process.cwd(), 'dead_letter.json');
const LOG_FILE = path.join(process.cwd(), 'service.log');
const AUTH_DIR = path.join(process.cwd(), 'baileys_auth_info');

// ═══════════════════════════════════════════════════
//  LOGGING ENGINE
// ═══════════════════════════════════════════════════
function rotateLogs() {
    try {
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
            fs.renameSync(LOG_FILE, LOG_FILE.replace('.log', `_${Date.now()}.log`));
        }
    } catch (_) {}
}
rotateLogs();

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(level, module, message, data = {}) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        module,
        message,
        ...(Object.keys(data).length > 0 ? { data } : {})
    };
    logStream.write(JSON.stringify(entry) + '\n');
    const color = level === 'ERROR' ? '\x1b[31m' : level === 'WARN' ? '\x1b[33m' : '\x1b[36m';
    process.stdout.write(`${color}[${entry.ts}] [${level}] [${module}] ${message}\x1b[0m\n`);
}

// ═══════════════════════════════════════════════════
//  STATS TRACKER
// ═══════════════════════════════════════════════════
const stats = {
    sent: 0, failed: 0, queued: 0, retried: 0, dropped: 0,
    uptime: Date.now(), reconnects: 0, lastSentAt: null,
    summary() {
        return {
            sent: this.sent, failed: this.failed, queued: this.queued,
            retried: this.retried, dropped: this.dropped,
            successRate: this.sent + this.failed > 0
                ? ((this.sent / (this.sent + this.failed)) * 100).toFixed(1) + '%' : 'N/A',
            uptimeSeconds: Math.round((Date.now() - this.uptime) / 1000),
            reconnects: this.reconnects,
            lastSentAt: this.lastSentAt
        };
    }
};

// ═══════════════════════════════════════════════════
//  MESSAGE QUEUE ENGINE
// ═══════════════════════════════════════════════════
const SEND_INTERVAL_MS = 1800;    // 1.8s between sends (avoid WhatsApp ban)
const MAX_RETRIES = 3;
const RETRY_DELAYS = [5000, 15000, 45000];

class MessageQueue {
    constructor() {
        this.queue = [];
        this.deadLetter = [];
        this.processing = false;
        this.processorTimer = null;
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(QUEUE_FILE)) {
                const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
                this.queue = Array.isArray(data) ? data : [];
                log('INFO', 'QUEUE', `Loaded ${this.queue.length} pending messages from disk`);
            }
            if (fs.existsSync(DEAD_LETTER_FILE)) {
                const data = JSON.parse(fs.readFileSync(DEAD_LETTER_FILE, 'utf8'));
                this.deadLetter = Array.isArray(data) ? data : [];
            }
        } catch (err) {
            log('WARN', 'QUEUE', 'Failed to load queue from disk', { err: err.message });
            this.queue = [];
        }
    }

    save() {
        try {
            fs.writeFileSync(QUEUE_FILE, JSON.stringify(this.queue, null, 2));
            fs.writeFileSync(DEAD_LETTER_FILE, JSON.stringify(this.deadLetter, null, 2));
        } catch (err) {
            log('ERROR', 'QUEUE', 'Failed to save queue to disk', { err: err.message });
        }
    }

    enqueue(msg, priority = 'normal') {
        const item = {
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
            ...msg,
            priority,
            retries: 0,
            enqueuedAt: new Date().toISOString(),
            nextRetryAt: Date.now()
        };
        if (priority === 'urgent') {
            this.queue.unshift(item);
        } else {
            this.queue.push(item);
        }
        stats.queued++;
        this.save();
        log('INFO', 'QUEUE', `Enqueued message (${priority})`, { id: item.id, phone: item.phone });
        return item.id;
    }

    enqueueAll(messages, priority = 'normal') {
        const ids = [];
        for (const msg of messages) {
            ids.push(this.enqueue(msg, priority));
        }
        return ids;
    }

    startProcessor() {
        if (this.processorTimer) return;
        log('INFO', 'QUEUE', 'Starting queue processor (1.8s interval)...');
        this.processorTimer = setInterval(() => this.processNext(), SEND_INTERVAL_MS);
    }

    stopProcessor() {
        if (this.processorTimer) {
            clearInterval(this.processorTimer);
            this.processorTimer = null;
        }
    }

    async processNext() {
        if (this.processing || clientStatus !== 'CONNECTED') return;
        const now = Date.now();
        const idx = this.queue.findIndex(m => m.nextRetryAt <= now);
        if (idx === -1) return;

        this.processing = true;
        const msg = this.queue[idx];

        try {
            await sendWhatsAppMessage(msg);
            this.queue.splice(idx, 1);
            stats.sent++;
            stats.lastSentAt = new Date().toISOString();
            log('INFO', 'QUEUE', `✅ Message sent`, { id: msg.id, phone: msg.phone, retries: msg.retries });
        } catch (err) {
            msg.retries++;
            stats.retried++;
            if (msg.retries >= MAX_RETRIES) {
                msg.failedAt = new Date().toISOString();
                msg.lastError = err.message;
                this.deadLetter.push(msg);
                this.queue.splice(idx, 1);
                stats.failed++;
                stats.dropped++;
                log('ERROR', 'QUEUE', `❌ Message permanently failed (dead letter)`, { id: msg.id, phone: msg.phone });
            } else {
                const delay = RETRY_DELAYS[msg.retries - 1] || 60000;
                msg.nextRetryAt = Date.now() + delay;
                log('WARN', 'QUEUE', `⚠️ Message failed, retry ${msg.retries}/${MAX_RETRIES} in ${delay / 1000}s`, { id: msg.id, err: err.message });
            }
        }

        this.save();
        this.processing = false;
    }

    getStats() {
        return {
            pending: this.queue.length,
            deadLetter: this.deadLetter.length,
            urgentCount: this.queue.filter(m => m.priority === 'urgent').length,
            normalCount: this.queue.filter(m => m.priority === 'normal').length,
            nextProcessIn: `${SEND_INTERVAL_MS}ms`
        };
    }

    clear(type = 'pending') {
        if (type === 'dead') {
            const count = this.deadLetter.length;
            this.deadLetter = [];
            this.save();
            return count;
        } else {
            const count = this.queue.length;
            this.queue = [];
            this.save();
            return count;
        }
    }
}

const messageQueue = new MessageQueue();

// ═══════════════════════════════════════════════════
//  BAILEYS WEBSOCKET CLIENT MANAGER
// ═══════════════════════════════════════════════════
let sock = null;
let clientStatus = 'INITIALIZING';
let currentQr = null;
let isInitializing = false;
let reconnectCount = 0;
const logger = pino({ level: 'silent' });

async function initBaileys() {
    if (isInitializing) return;
    isInitializing = true;
    log('INFO', 'BAILEYS', 'Initializing Baileys Engine...');
    clientStatus = 'INITIALIZING';

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: ['Lari Traders', 'Chrome', '125.0.0.0'],
            generateHighQualityLinkPreview: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                log('INFO', 'BAILEYS', 'Fresh QR Code generated');
                try {
                    currentQr = await qrcode.toDataURL(qr);
                    clientStatus = 'DISCONNECTED';
                    isInitializing = false;
                } catch (e) {
                    log('ERROR', 'BAILEYS', 'QR conversion error', { err: e.message });
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                log('WARN', 'BAILEYS', `Connection closed (status: ${statusCode}). Reconnect: ${shouldReconnect}`);
                clientStatus = 'DISCONNECTED';
                currentQr = null;
                isInitializing = false;
                messageQueue.stopProcessor();

                if (shouldReconnect) {
                    reconnectCount++;
                    stats.reconnects++;
                    const delay = Math.min(3000 * Math.pow(1.5, reconnectCount), 30000);
                    setTimeout(initBaileys, delay);
                } else {
                    log('ERROR', 'BAILEYS', 'Logged out from phone. Manual pairing required.');
                    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
                    reconnectCount = 0;
                    setTimeout(initBaileys, 3000);
                }
            } else if (connection === 'open') {
                log('INFO', 'BAILEYS', 'WhatsApp READY ✅ — Connected via Baileys Engine');
                clientStatus = 'CONNECTED';
                currentQr = null;
                isInitializing = false;
                reconnectCount = 0;
                messageQueue.startProcessor();
            }
        });
    } catch (err) {
        log('ERROR', 'BAILEYS', 'Failed to initialize Baileys', { err: err.message });
        clientStatus = 'DISCONNECTED';
        isInitializing = false;
        setTimeout(initBaileys, 5000);
    }
}

// ═══════════════════════════════════════════════════
//  MESSAGE SENDER
// ═══════════════════════════════════════════════════
function formatJid(phone) {
    let clean = String(phone).replace(/\D/g, '');
    if (clean.length === 10) {
        clean = '91' + clean;
    }
    return `${clean}@s.whatsapp.net`;
}

async function sendWhatsAppMessage(msg) {
    if (!sock || clientStatus !== 'CONNECTED') {
        throw new Error('WhatsApp is not connected');
    }
    const jid = formatJid(msg.phone);
    if (msg.type === 'media') {
        const buffer = Buffer.from(msg.media, 'base64');
        const isPdf = msg.filename && msg.filename.toLowerCase().endsWith('.pdf');
        if (isPdf) {
            await sock.sendMessage(jid, {
                document: buffer,
                mimetype: 'application/pdf',
                fileName: msg.filename,
                caption: msg.caption || ''
            });
        } else {
            await sock.sendMessage(jid, {
                image: buffer,
                caption: msg.caption || ''
            });
        }
    } else {
        await sock.sendMessage(jid, { text: msg.message });
    }
}

// ═══════════════════════════════════════════════════
//  EXPRESS API ROUTES
// ═══════════════════════════════════════════════════
function requireInternalSecret(req, res, next) {
    const provided = req.headers['x-internal-secret'];
    if (provided !== INTERNAL_SECRET) {
        log('WARN', 'AUTH', `Rejected request — invalid internal secret from ${req.ip}`);
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}

app.use((req, _res, next) => {
    log('INFO', 'API', `${req.method} ${req.path}`);
    next();
});

// ── Health Check ─────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({
        status: clientStatus,
        queue: messageQueue.getStats(),
        stats: stats.summary(),
        version: '3.0.0-baileys'
    });
});

// ── Visual QR & Pairing Code Page ────────────────
app.get('/', (_req, res) => {
    if (clientStatus === 'CONNECTED') {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>WhatsApp Connected | Lari Traders</title></head>
            <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;text-align:center;padding:60px 20px;background:#0b141a;color:#e9edef;">
                <h1 style="color:#25D366;font-size:32px;">✅ WhatsApp Connected!</h1>
                <p style="color:#8696a0;font-size:16px;">Lari Traders Baileys WebSocket Engine is active and running (RAM: ~35MB).</p>
                <p style="color:#00a884;font-size:14px;margin-top:20px;">Uptime: ${Math.floor(process.uptime())}s</p>
            </body>
            </html>
        `);
    }

    const qrSrc = currentQr || '';
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta http-equiv="refresh" content="5">
            <title>Scan WhatsApp QR Code | Lari Traders</title>
        </head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;text-align:center;padding:30px 20px;background:#0b141a;color:#e9edef;">
            <h2 style="margin-bottom:8px;color:#00a884;">📱 Connect WhatsApp (Baileys Engine)</h2>
            <p style="color:#8696a0;font-size:14px;margin-bottom:20px;">Choose <b>QR Scan</b> or <b>Pairing Code</b> below</p>
            
            <div style="display:flex;justify-content:center;gap:30px;flex-wrap:wrap;align-items:flex-start;">
                <!-- QR Box -->
                <div style="background:#fff;display:inline-block;padding:16px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,0.5);">
                    ${qrSrc ? `<img src="${qrSrc}" style="width:260px;height:260px;display:block;"/>` : '<div style="width:260px;height:260px;display:flex;align-items:center;justify-content:center;color:#333;font-weight:bold;">Generating QR...<br/>Auto-refreshing in 5s</div>'}
                </div>
            </div>

            <div style="margin-top:30px;background:#111b21;display:inline-block;padding:20px;border-radius:12px;max-width:400px;text-align:left;">
                <h4 style="margin:0 0 10px 0;color:#25D366;">Option B: Get 8-Digit Pairing Code</h4>
                <p style="font-size:12px;color:#8696a0;margin-bottom:12px;">Open WhatsApp on phone ➔ <b>Linked Devices</b> ➔ <b>Link a Device</b> ➔ <b>Link with phone number instead</b></p>
                <div style="display:flex;gap:8px;">
                    <input id="phoneInput" type="text" placeholder="e.g. 917084285785" style="padding:8px 12px;border-radius:6px;border:1px solid #333;background:#202c33;color:#fff;flex:1;font-size:14px;"/>
                    <button onclick="getCode()" style="background:#00a884;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:bold;cursor:pointer;">Get Code</button>
                </div>
                <div id="codeResult" style="margin-top:12px;font-size:18px;font-weight:bold;color:#f7a827;text-align:center;"></div>
            </div>

            <script>
                async function getCode() {
                    const phone = document.getElementById('phoneInput').value.trim();
                    if(!phone) { alert('Please enter phone number'); return; }
                    document.getElementById('codeResult').innerText = 'Generating code...';
                    try {
                        const res = await fetch('/pairing-code?phone=' + encodeURIComponent(phone));
                        const data = await res.json();
                        if(data.success) {
                            document.getElementById('codeResult').innerHTML = 'PAIRING CODE: <span style="font-size:24px;color:#25D366;letter-spacing:2px;">' + data.pairingCode + '</span>';
                        } else {
                            document.getElementById('codeResult').innerText = 'Error: ' + (data.error || data.message);
                        }
                    } catch(e) {
                        document.getElementById('codeResult').innerText = 'Failed to generate code';
                    }
                }
            </script>

            <p style="font-size:13px;color:#8696a0;margin-top:20px;">Status: <b style="color:#f7a827;">${clientStatus}</b> (Ultra-lightweight: ~35MB RAM)</p>
        </body>
        </html>
    `);
});

// ── Status ───────────────────────────────────────
app.get('/status', (_req, res) => {
    res.json({ status: clientStatus });
});

// ── QR Code JSON ─────────────────────────────────
app.get('/qr', (_req, res) => {
    if (clientStatus === 'CONNECTED') return res.json({ qr: null, message: 'Already connected' });
    res.json({ qr: currentQr, status: clientStatus });
});

// ── Pairing Code ─────────────────────────────────
app.get('/pairing-code', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone query parameter is required (e.g. ?phone=917084285785)' });
    if (clientStatus === 'CONNECTED') return res.json({ success: false, message: 'Already connected' });
    try {
        if (!sock) {
            return res.status(503).json({ success: false, error: 'Baileys engine initializing. Try again in 5 seconds.' });
        }
        let cleanPhone = String(phone).replace(/\D/g, '');
        if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;

        const code = await sock.requestPairingCode(cleanPhone);
        log('INFO', 'BAILEYS', `Pairing code generated for ${cleanPhone}: ${code}`);
        res.json({ success: true, pairingCode: code, phone: cleanPhone });
    } catch (err) {
        log('ERROR', 'BAILEYS', 'Pairing code generation failed', { err: err.message });
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Logout ───────────────────────────────────────
app.post('/logout', async (_req, res) => {
    try {
        log('INFO', 'API', 'Logging out WhatsApp session...');
        if (sock) {
            try { await sock.logout(); } catch (_) {}
            try { sock.end(); } catch (_) {}
        }
        clientStatus = 'DISCONNECTED';
        currentQr = null;
        messageQueue.stopProcessor();
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
        setTimeout(initBaileys, 1500);
        res.json({ success: true, message: 'Logged out. Reinitializing...' });
    } catch (err) {
        log('ERROR', 'API', 'Logout failed', { err: err.message });
        res.status(500).json({ error: 'Logout failed: ' + err.message });
    }
});

// ── Send Single Text ─────────────────────────────
app.post('/send', requireInternalSecret, (req, res) => {
    const { phone, message, priority = 'normal' } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Missing phone or message' });

    const id = messageQueue.enqueue({ type: 'text', phone, message }, priority);
    res.json({ success: true, messageId: id, queued: true, queueSize: messageQueue.queue.length });
});

// ── Send Single Media ────────────────────────────
app.post('/send-media', requireInternalSecret, (req, res) => {
    const { phone, media, filename, caption, priority = 'normal' } = req.body;
    if (!phone || !media || !filename) return res.status(400).json({ error: 'Missing phone, media, or filename' });

    const id = messageQueue.enqueue({ type: 'media', phone, media, filename, caption }, priority);
    res.json({ success: true, messageId: id, queued: true, queueSize: messageQueue.queue.length });
});

// ── Bulk Send ─────────────────────────────────────
app.post('/send-bulk', requireInternalSecret, (req, res) => {
    const { messages, priority = 'normal' } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages must be a non-empty array' });
    }
    const valid = messages.filter(m => m.phone && (m.message || (m.media && m.filename)));
    if (valid.length === 0) return res.status(400).json({ error: 'No valid messages in batch' });

    const ids = messageQueue.enqueueAll(valid.map(m => ({
        type: m.media ? 'media' : 'text', ...m
    })), priority);

    const estimatedSeconds = Math.round((ids.length * SEND_INTERVAL_MS) / 1000);
    res.json({
        success: true,
        queued: ids.length,
        skipped: messages.length - valid.length,
        messageIds: ids,
        estimatedDeliverySeconds: estimatedSeconds
    });
});

// ── Queue Stats ───────────────────────────────────
app.get('/queue/stats', (_req, res) => {
    res.json({ ...messageQueue.getStats(), stats: stats.summary() });
});

// ── Clear Queue ───────────────────────────────────
app.delete('/queue', requireInternalSecret, (req, res) => {
    const type = req.query.type || 'pending';
    const cleared = messageQueue.clear(type);
    log('WARN', 'API', `Queue cleared`, { type, cleared });
    res.json({ success: true, cleared, type });
});

// ── View Dead Letters ─────────────────────────────
app.get('/queue/dead', (_req, res) => {
    res.json({ count: messageQueue.deadLetter.length, messages: messageQueue.deadLetter.slice(-50) });
});

// ── Retry Dead Letters ────────────────────────────
app.post('/queue/retry-dead', (_req, res) => {
    if (messageQueue.deadLetter.length === 0) return res.json({ success: true, retried: 0 });
    const revived = messageQueue.deadLetter.map(m => ({
        type: m.type, phone: m.phone, message: m.message,
        media: m.media, filename: m.filename, caption: m.caption
    }));
    messageQueue.deadLetter = [];
    const ids = messageQueue.enqueueAll(revived, 'normal');
    res.json({ success: true, retried: ids.length, messageIds: ids });
});

// ── Generate Invoice PDF (On-Demand Puppeteer) ───
app.post('/generate-pdf', requireInternalSecret, express.json({ limit: '10mb' }), async (req, res) => {
    const { html } = req.body;
    if (!html) return res.status(400).json({ success: false, error: 'HTML content required' });

    const sanitizedHtml = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<iframe[^>]*>.*?<\/iframe>/gi, '')
        .replace(/\bon\w+\s*=/gi, 'data-removed=');

    let browser = null;
    let page = null;
    try {
        const puppeteer = (await import('puppeteer')).default;
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        page = await browser.newPage();
        await page.setJavaScriptEnabled(false);
        await page.setViewport({ width: 794, height: 1123 });
        await page.setContent(sanitizedHtml, { waitUntil: 'networkidle0', timeout: 15000 });
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
        });
        const base64 = Buffer.from(pdfBuffer).toString('base64');
        log('INFO', 'PDF', 'Invoice PDF generated via Puppeteer');
        res.json({ success: true, pdf: base64 });
    } catch (err) {
        log('ERROR', 'PDF', 'PDF generation failed', { err: err.message });
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (page) { try { await page.close(); } catch (_) {} }
        if (browser) { try { await browser.close(); } catch (_) {} }
    }
});

// ── 404 Handler ───────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful Shutdown
async function shutdown(signal) {
    log('INFO', 'SYSTEM', `Received ${signal} — shutting down`);
    messageQueue.stopProcessor();
    messageQueue.save();
    try { if (sock) sock.end(); } catch (_) {}
    logStream.end();
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => log('ERROR', 'SYSTEM', 'Uncaught exception', { err: err.message }));
process.on('unhandledRejection', (r) => log('ERROR', 'SYSTEM', 'Unhandled rejection', { reason: String(r) }));

// Boot
app.listen(PORT, '0.0.0.0', () => {
    log('INFO', 'SYSTEM', `✅ Baileys Engine HTTP server listening on http://0.0.0.0:${PORT}`);
    log('INFO', 'SYSTEM', `📋 Endpoints: /health /status /qr /pairing-code /send /send-bulk /send-media /queue/stats`);
    initBaileys();
});
