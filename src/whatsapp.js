const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    Browsers,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
fs.ensureDirSync(SESSIONS_DIR);

const sessions = new Map();
const activeSockets = new Map();
const logger = pino({ level: 'silent' });

/**
 * Helper to get the correct session path
 */
function getSessionPath(uniqueId) {
    return path.join(__dirname, '..', 'sessions', uniqueId);
}

/**
 * Checks if a session is already physically linked on disk
 */
function isLinked(uniqueId) {
    const linkedPath = path.join(getSessionPath(uniqueId), 'linked.json');
    return fs.existsSync(linkedPath);
}

/**
 * Generate a random matdev ID
 */
function generateMatdevId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = 'matdev-';
    for (let i = 0; i < 8; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

/**
 * Check if a uniqueId exists and is linked
 */
function uniqueIdExists(uniqueId) {
    return isLinked(uniqueId);
}

/**
 * Get the uniqueId for a sessionId
 */
async function getUniqueId(sessionId) {
    const s = sessions.get(sessionId);
    return s ? s.uniqueId : null;
}

/**
 * Cleans the phone number for Baileys v7 pairing.
 * Removes leading '+', spaces, dashes, and letters.
 * @param {string|null} number 
 */
function cleanPhoneNumber(number) {
    if (!number) return null;
    let cleaned = String(number).trim();
    if (cleaned.startsWith('+')) {
        cleaned = cleaned.substring(1);
    }
    return cleaned.replace(/\D/g, '');
}

/**
 * NEW: Clean phone number to E.164 format (no +, no spaces)
 * Baileys v7 will fail if any symbols are present.
 */
function formatPhoneNumber(number) {
    const cleaned = number.replace(/\D/g, '');
    return cleaned; // Returns only digits: e.g. 447123456789
}

/**
 * Main Socket Factory
 */
async function createSocketForSession(sessionId, uniqueId, method = 'qr', phoneNumber = null) {
    const dir = getSessionPath(uniqueId);
    
    // Kill any existing socket instance for this ID to prevent session conflicts
    if (activeSockets.has(uniqueId)) {
        const oldSock = activeSockets.get(uniqueId);
        oldSock.ev.removeAllListeners();
        oldSock.end();
        activeSockets.delete(uniqueId);
    }

    // Load State - v7 uses LID mapping, so we MUST use cacheable store
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            // Optimization: Wrap keys in memory cache to prevent "QR Loop" disk lag
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        // v7 is most stable with standard Chrome signatures
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
    });

    // Store socket reference
    activeSockets.set(uniqueId, sock);
    const sessionData = sessions.get(sessionId);
    if (sessionData) sessionData.socket = sock;
    // Ensure pairingRequested flag exists
    if (sessionData && typeof sessionData.pairingRequested === 'undefined') {
        sessionData.pairingRequested = false;
    }

    // Save credentials whenever updated (critical for v7 LIDs)
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const s = sessions.get(sessionId);
        if (!s) return;

        // 1. Handle QR Generation
        if (qr && method === 'qr') {
            console.log(`[WhatsApp] New QR generated for ${uniqueId}`);
            const dataUrl = await qrcode.toDataURL(qr);
            s.qr = dataUrl.split(',')[1];
            s.status = 'qr';
        }

        // --- UPDATED PAIRING CODE LOGIC (FIXED) ---
        if (method === 'pairing' && !sock.authState.creds.registered && !s.pairingCode && !s.pairingRequested) {
            const cleaned = cleanPhoneNumber(phoneNumber);
            if (!cleaned) {
                console.error(`[MATDEV] Error: Pairing requested for ${uniqueId} but phoneNumber is null or empty.`);
                s.status = 'error_invalid_phone';
                return; 
            }
            if (qr || connection === 'connecting') {
                try {
                    s.pairingRequested = true; // Prevent duplicate requests
                    console.log(`[MATDEV] Requesting Pairing Code for cleaned number: ${cleaned}`);
                    await delay(10000); // Essential: Wait for socket handshake (10s is recommended for v7 stability)
                    const code = await sock.requestPairingCode(cleaned);
                    s.pairingCode = code;
                    s.status = 'pairing_code';
                    console.log(`[MATDEV] Code Generated: ${code}`);
                } catch (err) {
                    console.error('[MATDEV] Pairing Code Error:', err.message);
                    if (err.message.includes('429')) s.status = 'rate_limited';
                }
            }
        }

        // 2. Connection Success Logic
        if (connection === 'open') {
            console.log(`[WhatsApp] ${uniqueId} Handshake Complete. Stabilizing...`);
            s.status = 'finalizing'; // UI shows "Finishing setup..."
            await delay(10000); // Allow phone to finish background sync
            s.status = 'connected';
            s.qr = null;
            s.pairingCode = null;
            // Save extra info: WhatsApp number and name
            let waNumber = null;
            let waName = null;
            if (sock.user) {
                waNumber = sock.user.id ? sock.user.id.split(':')[0] : null;
                waName = sock.user.name || null;
            }
            fs.writeJsonSync(path.join(dir, 'linked.json'), {
                linked: true,
                at: Date.now(),
                waNumber,
                waName
            });
            // Send success message to self
            const jid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            await sock.sendMessage(jid, { text: `🚀 *MATDEV Linker Active*\n\nYour ID: \`${uniqueId}\` is now successfully connected.` });
            // NEW: Delay cleanup for 60 seconds after successful link
            setTimeout(() => {
                if (activeSockets.has(uniqueId)) {
                    sock.ev.removeAllListeners();
                    sock.end();
                    activeSockets.delete(uniqueId);
                }
                if (sessions.has(sessionId)) {
                    sessions.delete(sessionId);
                }
                console.log(`[WhatsApp] Session ${sessionId} cleaned up after 60s post-link.`);
            }, 60000);
        }

        // 3. Disconnect Handling
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`[WhatsApp] Closed ${uniqueId}. Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(() => {
                    createSocketForSession(sessionId, uniqueId, method, phoneNumber);
                }, 5000);
            } else {
                s.status = 'auth_failed';
                activeSockets.delete(uniqueId);
                // If logged out, we should clean the session folder
                fs.removeSync(dir);
            }
        }
    });

    return sock;
}

/**
 * Exported API Methods
 */
async function createSession({ uniqueId, method, phoneNumber }) {
    if (!uniqueId) {
        uniqueId = 'matdev-' + Math.random().toString(36).substring(2, 10);
    }

    if (isLinked(uniqueId)) {
        throw new Error('This ID is already linked to a phone.');
    }

    const sessionId = uuidv4();
    sessions.set(sessionId, {
        uniqueId,
        status: 'initializing',
        qr: null,
        pairingCode: null,
        phoneNumber
    });

    // Start in background
    createSocketForSession(sessionId, uniqueId, method, phoneNumber).catch(e => {
        console.error("[WhatsApp] Startup Fatal Error:", e);
    });

    return { sessionId, uniqueId };
}

async function getStatus(sessionId) {
    const s = sessions.get(sessionId);
    return s ? s.status : 'not_found';
}

async function getQR(sessionId) {
    const s = sessions.get(sessionId);
    return s ? s.qr : null;
}

async function getPairingCode(sessionId) {
    const s = sessions.get(sessionId);
    // Defensive: If pairingCode is an object, convert to string
    if (!s) return null;
    if (typeof s.pairingCode === 'object' && s.pairingCode !== null) {
        return JSON.stringify(s.pairingCode);
    }
    return s.pairingCode || null;
}

module.exports = { 
    createSession, 
    getQR, 
    getStatus, 
    getPairingCode,
    generateMatdevId,
    uniqueIdExists,
    getUniqueId,
    getSessionPath
};