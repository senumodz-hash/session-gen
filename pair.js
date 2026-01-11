const { makeid } = require('./gen-id');
const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const router = express.Router();

function removeFolder(folderPath) {
  try {
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
  } catch {}
}

router.get('/code', async (req, res) => {
  const id = makeid();
  const tempDir = path.join(__dirname, 'temp', id);
  const phoneNumber = (req.query.number || '').replace(/\D/g, '');

  if (!phoneNumber) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  const logger = pino({ level: "fatal" });
  let responded = false;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(tempDir);

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS("Safari"),
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Timeout safety
    setTimeout(() => {
      if (!responded) {
        responded = true;
        removeFolder(tempDir);
        sock.ws.close();
        res.status(408).json({ error: "Timeout. Try again." });
      }
    }, 60_000);

    sock.ev.on('connection.update', async ({ connection }) => {
      if (connection === 'open') {
        await delay(3000);

        try {
          const credsPath = path.join(tempDir, 'creds.json');
          const sessionData = fs.readFileSync(credsPath, 'utf8');
          const base64 = Buffer.from(sessionData).toString('base64');
          const sessionId = `SENU MD~${base64}`;

          await sock.sendMessage(sock.user.id, { text: sessionId });

        } catch (err) {
          console.error("Session error:", err.message);
        } finally {
          await delay(1000);
          sock.ws.close();
          removeFolder(tempDir);
        }
      }
    });

    if (!sock.authState.creds.registered) {
      await delay(1500);
      const pairingCode = await sock.requestPairingCode(phoneNumber, "EDITH123");

      if (!responded) {
        responded = true;
        return res.json({ code: pairingCode });
      }
    }

  } catch (err) {
    console.error("Fatal:", err.message);
    removeFolder(tempDir);
    if (!res.headersSent) {
      res.status(500).json({ error: "Service unavailable" });
    }
  }
});

module.exports = router;
