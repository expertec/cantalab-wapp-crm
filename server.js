/* ---------- DEPENDENCIAS ---------- */
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

/* ---------- FIREBASE ADMIN ---------- */
import { admin, db } from './firebaseAdmin.js';

/* ---------- WHATSAPP & UTILIDADES ---------- */
import {
  connectToWhatsApp,
  getLatestQR,
  getConnectionStatus,
  getWhatsAppSock,
} from './whatsappService.js';
import { generarEstrategia } from './chatGpt.js';
import { generatePDF } from './utils/generatePDF.js';
import { processSequences } from './processSequences.js'; // ← si ya tenías este helper

/* ---------- EXPRESS APP ---------- */
const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());

/* ============================================================
   ENDPOINTS AUXILIARES
   ============================================================ */

/** Verifica que el secret de Firebase exista en /etc/secrets */
app.get('/api/debug-env', (_req, res) => {
  const keyPath = path.join('/etc/secrets', 'serviceAccountKey.json');
  res.json({
    archivoSecreto: fs.existsSync(keyPath)
      ? 'Archivo de llave de Firebase OK'
      : 'No se encontró el archivo secreto',
    ruta: keyPath,
  });
});

/** Estado de conexión a WhatsApp + QR */
app.get('/api/whatsapp/status', (_req, res) => {
  res.json({ status: getConnectionStatus(), qr: getLatestQR() });
});

/** Forzado de conexión a WhatsApp (útil en tests) */
app.get('/api/whatsapp/connect', async (_req, res) => {
  try {
    await connectToWhatsApp();
    res.json({
      status: 'Conectado',
      message: 'Conexión iniciada. Escanea el QR si es necesario.',
    });
  } catch (err) {
    console.error('Error al conectar con WhatsApp:', err);
    res.status(500).json({ status: 'Error', message: 'No se pudo conectar.' });
  }
});

/* ============================================================
   ENDPOINTS DE PRUEBA (texto, imagen, audio)
   ============================================================ */

app.get('/api/whatsapp/send/text', async (req, res) => {
  try {
    const phoneRaw = req.query.phone;
    if (!phoneRaw) return res.status(400).json({ error: 'phone requerido' });

    const sock = getWhatsAppSock();
    if (!sock)
      return res.status(500).json({ error: 'Sin conexión a WhatsApp' });

    const phone = normalizePhone(phoneRaw);
    await sendWithTimeout(sock.sendMessage(`${phone}@s.whatsapp.net`, { text: 'Mensaje de prueba (texto)' }));

    res.json({ success: true, message: 'Mensaje de texto enviado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/send/image', async (req, res) => {
  try {
    const phoneRaw = req.query.phone;
    if (!phoneRaw) return res.status(400).json({ error: 'phone requerido' });

    const sock = getWhatsAppSock();
    if (!sock)
      return res.status(500).json({ error: 'Sin conexión a WhatsApp' });

    const phone = normalizePhone(phoneRaw);
    await sock.sendMessage(`${phone}@s.whatsapp.net`, {
      image: { url: 'https://via.placeholder.com/150' },
    });

    res.json({ success: true, message: 'Imagen enviada' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/send/audio', async (req, res) => {
  try {
    const phoneRaw = req.query.phone;
    if (!phoneRaw) return res.status(400).json({ error: 'phone requerido' });

    const sock = getWhatsAppSock();
    if (!sock)
      return res.status(500).json({ error: 'Sin conexión a WhatsApp' });

    const phone = normalizePhone(phoneRaw);
    await sock.sendMessage(`${phone}@s.whatsapp.net`, {
      audio: {
        url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
      },
      mimetype: 'audio/mp4',
      fileName: 'prueba.m4a',
      ptt: true,
    });

    res.json({ success: true, message: 'Audio enviado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   ENVÍO DE MENSAJES DESDE EL FRONT
   ============================================================ */

app.post('/api/whatsapp/send-message', async (req, res) => {
  const { leadId, message } = req.body;
  if (!leadId || !message)
    return res.status(400).json({ error: 'leadId y message son requeridos' });

  try {
    const sock = getWhatsAppSock();
    if (!sock)
      return res.status(500).json({ error: 'Sin conexión a WhatsApp' });

    const phone = normalizePhone(leadId);
    const jid = `${phone}@s.whatsapp.net`;

    await sendWithTimeout(sock.sendMessage(jid, { text: message }));

    // Registro en Firestore
    await db
      .collection('leads')
      .doc(phone)
      .collection('messages')
      .add({
        content: message,
        sender: 'business',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ success: true, message: 'Mensaje enviado y guardado' });
  } catch (err) {
    console.error('Error enviando mensaje:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   FUNCIONES AUXILIARES
   ============================================================ */

function normalizePhone(str) {
  const clean = str.replace('@s.whatsapp.net', '');
  return clean.startsWith('521') ? clean : `521${clean}`;
}

async function sendWithTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, r) => setTimeout(() => r(new Error('Timed out')), ms)),
  ]);
}

/* ============================================================
   FUNCIONES EXISTENTES PARA SEC. / PDF  (SIN CAMBIOS IMPORTANTES)
   ============================================================ */

// Mantén intactas tus funciones enviarMensaje, procesarMensajePDFChatGPT, etc.
// ─────────────────────────────────────────────────────────────────────────────
async function enviarMensaje(lead, mensaje) {
  try {
    const sock = getWhatsAppSock();
    if (!sock) return console.error('Sin conexión a WhatsApp');

    const jid = `${normalizePhone(lead.telefono)}@s.whatsapp.net`;
    const contenido = mensaje.contenido;

    switch (mensaje.type) {
      case 'texto':
        await sock.sendMessage(jid, { text: contenido });
        break;
      case 'imagen':
        await sock.sendMessage(jid, { image: { url: contenido } });
        break;
      case 'audio':
        const audioBuf = await axios
          .get(contenido, { responseType: 'arraybuffer' })
          .then((r) => Buffer.from(r.data, 'binary'));
        await sock.sendMessage(jid, { audio: audioBuf, ptt: true });
        break;
      case 'pdfChatGPT':
        await procesarMensajePDFChatGPT(lead);
        break;
      default:
        console.warn('Tipo de mensaje no soportado:', mensaje.type);
    }
  } catch (err) {
    console.error('enviarMensaje error:', err);
  }
}

async function procesarMensajePDFChatGPT(lead) {
  try {
    if (!lead.pdfEstrategia) {
      const estrategia = await generarEstrategia(lead);
      const pdfPath = await generatePDF(lead, estrategia);
      await db.collection('leads').doc(lead.id).update({ pdfEstrategia: pdfPath });
      lead.pdfEstrategia = pdfPath;
    }
    const pdfBuf = fs.readFileSync(lead.pdfEstrategia);
    const jid = `${normalizePhone(lead.telefono)}@s.whatsapp.net`;
    const sock = getWhatsAppSock();
    await sock.sendMessage(jid, {
      document: pdfBuf,
      fileName: `Estrategia-${lead.nombre}.pdf`,
      mimetype: 'application/pdf',
    });
    await db.collection('leads').doc(lead.id).update({ etiqueta: 'planEnviado' });
  } catch (err) {
    console.error('procesarMensajePDFChatGPT error:', err);
  }
}

/* ============================================================
   SCHEDULER
   ============================================================ */

cron.schedule('* * * * *', () => {
  processSequences();
});

/* ============================================================
   ARRANQUE DEL SERVIDOR
   ============================================================ */

app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  connectToWhatsApp().catch((err) =>
    console.error('Error al conectar WhatsApp en startup:', err),
  );
});
