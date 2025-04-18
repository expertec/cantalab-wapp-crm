import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';
import { db } from './firebaseAdmin.js';

let latestQR = null;
let connectionStatus = 'Desconectado';
let whatsappSock = null;
const localAuthFolder = '/var/data';

/* ============================================================
   CONEXIÓN PRINCIPAL
   ============================================================ */
export async function connectToWhatsApp() {
  if (!fs.existsSync(localAuthFolder)) fs.mkdirSync(localAuthFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(localAuthFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    logger: Pino({ level: 'info' }),
    printQRInTerminal: true,
    version,
  });
  whatsappSock = sock;

  /* ---------- EVENTS: connection.update ---------- */
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQR = qr;
      connectionStatus = 'QR disponible. Escanéalo.';
      QRCode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      connectionStatus = 'Conectado';
      latestQR = null;
    }
    if (connection === 'close') {
      connectionStatus = 'Desconectado';
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) clearAuthFolder();
      connectToWhatsApp(); // re‑try automáticamente
    }
  });

  sock.ev.on('creds.update', saveCreds);

  /* ---------- EVENTS: messages.upsert ---------- */
  sock.ev.on('messages.upsert', async (m) => {
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;               // ignoramos salientes
      const jid   = msg.key.remoteJid;
      if (jid.endsWith('@g.us')) continue;        // ignoramos grupos
      const phone = jid.split('@')[0];           // 521__________

      // 1. Guarda/crea el lead
      const leadRef = db.collection('leads').doc(phone);
      const docSnap = await leadRef.get();
      if (!docSnap.exists) {
        await leadRef.set({
          nombre: msg.pushName || 'Sin nombre',
          telefono: phone,
          fecha_creacion: new Date(),
          estado: 'nuevo',
          etiquetas: ['NuevoLead'],
          secuenciasActivas: [],
          source: 'WhatsApp',
        });
      }

      // 2. Guarda el mensaje entrante
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';
      await leadRef.collection('messages').add({
        content: text,
        sender: 'lead',
        timestamp: new Date(),
      });
    }
  });

  return sock;
}

/* ============================================================
   HELPERS
   ============================================================ */
function clearAuthFolder() {
  try {
    fs.readdirSync(localAuthFolder).forEach((f) =>
      fs.rmSync(path.join(localAuthFolder, f), { recursive: true, force: true }),
    );
  } catch {}
}

export function getLatestQR()       { return latestQR; }
export function getConnectionStatus() { return connectionStatus; }
export function getWhatsAppSock()     { return whatsappSock; }

/* Envío directo desde otros módulos (opcional) */
export async function sendMessageToLead(leadId, text) {
  const sock = getWhatsAppSock();
  if (!sock) throw new Error('Sin conexión a WhatsApp');
  const phone = leadId.replace('@s.whatsapp.net', '').replace(/^(\d{10})$/, '521$1');
  await sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
}
