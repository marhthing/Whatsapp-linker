const path = require('path');
const express = require('express');
const whatsapp = require('./whatsapp');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow only Vercel frontend to access API
app.use(cors({
  origin: 'https://matdevlinker.vercel.app',
  methods: ['GET', 'POST'],
  credentials: false
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Create new session
app.post('/api/session', async (req, res) => {
  try {
    const { uniqueId, method, phoneNumber } = req.body || {};
    const session = await whatsapp.createSession({ uniqueId, method, phoneNumber });
    res.json({ sessionId: session.sessionId, uniqueId: session.uniqueId });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to create session' });
  }
});

app.get('/api/session/:sessionId/qr', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const qr = await whatsapp.getQR(sessionId);
    if (!qr) return res.status(404).json({ error: 'QR not available' });
    res.json({ qr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get QR' });
  }
});

app.get('/api/session/:sessionId/status', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const status = await whatsapp.getStatus(sessionId);
    res.json({ status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

app.get('/api/session/:sessionId/id', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const uniqueId = await whatsapp.getUniqueId(sessionId);
    res.json({ uniqueId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get unique id' });
  }
});

// Check if uniqueId exists
app.get('/api/uniqueid/:uniqueId/exists', async (req, res) => {
  const { uniqueId } = req.params;
  try {
    const exists = await whatsapp.uniqueIdExists(uniqueId);
    res.json({ exists });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check id' });
  }
});

// Generate a matdev unique id
app.get('/api/uniqueid/generate', (req, res) => {
  res.json({ uniqueId: whatsapp.generateMatdevId() });
});

// Get pairing code
app.get('/api/session/:sessionId/pairing-code', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const code = await whatsapp.getPairingCode(sessionId);
    if (!code || code === '{}' || code === 'null') return res.status(404).json({ error: 'Pairing code not available' });
    res.json({ pairingCode: code });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get pairing code' });
  }
});

// API for bot integration: Get session folder info by uniqueId
app.get('/api/bot/session/:uniqueId', async (req, res) => {
  const { uniqueId } = req.params;
  const sessionPath = getSessionPath(uniqueId);
  const linkedPath = path.join(sessionPath, 'linked.json');
  if (fs.existsSync(sessionPath) && fs.existsSync(linkedPath)) {
    res.json({ exists: true, path: sessionPath, linked: true });
  } else {
    res.status(404).json({ exists: false, linked: false });
  }
});

// Serve minimal frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
