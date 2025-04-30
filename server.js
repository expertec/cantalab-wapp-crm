// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import fs from 'fs';
import path from 'path';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';

dotenv.config();

// ——— Configurar FFmpeg ———
ffmpeg.setFfmpegPath(ffmpegPath.path);

// Middleware para recibir archivos de audio
const upload = multer({ dest: 'uploads/' });

import { db } from './firebaseAdmin.js';
import {
  connectToWhatsApp,
  getLatestQR,
  getConnectionStatus,
  sendMessageToLead,
  getSessionPhone
} from './whatsappService.js';
import {
  processSequences,
  generateLetras,
  sendLetras
} from './scheduler.js';

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());

// Endpoint para consultar el estado de WhatsApp (QR y conexión)
app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    status: getConnectionStatus(),
    qr: getLatestQR()
  });
});

// Nuevo endpoint para obtener el número de sesión
app.get('/api/whatsapp/number', (req, res) => {
  const phone = getSessionPhone();
  if (phone) {
    res.json({ phone });
  } else {
    res.status(503).json({ error: 'WhatsApp no conectado' });
  }
});

// Endpoint para enviar mensaje de WhatsApp
app.post('/api/whatsapp/send-message', async (req, res) => {
  const { leadId, message } = req.body;
  try {
    const leadRef = db.collection('leads').doc(leadId);
    const leadDoc = await leadRef.get();
    if (!leadDoc.exists) {
      return res.status(404).json({ error: "Lead no encontrado" });
    }

    // Normalizar número con libphonenumber-js
    const raw = leadDoc.data().telefono;
    const input = raw.startsWith('+') ? raw : `+${raw}`;
    const pn = parsePhoneNumberFromString(input);
    if (!pn || !pn.isValid()) {
      return res.status(400).json({ error: 'Teléfono inválido' });
    }
    const e164 = pn.number.slice(1);

    // Enviar mensaje
    const result = await sendMessageToLead(e164, message);
    return res.json(result);
  } catch (error) {
    console.error("Error enviando mensaje de WhatsApp:", error);
    return res.status(500).json({ error: error.message });
  }
});

// (Opcional) Marcar todos los mensajes de un lead como leídos
app.post('/api/whatsapp/mark-read', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) {
    return res.status(400).json({ error: "Falta leadId en el body" });
  }
  try {
    await db.collection('leads').doc(leadId).update({ unreadCount: 0 });
    return res.json({ success: true });
  } catch (err) {
    console.error("Error marcando como leídos:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ——— Endpoint para recibir y convertir nota de voz ———
app.post(
  '/api/whatsapp/send-audio',
  upload.single('audio'),
  async (req, res) => {
    const { leadId } = req.body;
    const tmpPath = req.file.path;

    try {
      // 1) Leer el .webm temporal
      const webmBuffer = fs.readFileSync(tmpPath);
      fs.unlinkSync(tmpPath);

      // 2) Convertir a OGG/Opus
      const tempIn  = path.join('uploads', `in-${Date.now()}.webm`);
      const tempOut = path.join('uploads', `out-${Date.now()}.ogg`);
      fs.writeFileSync(tempIn, webmBuffer);

      await new Promise((resolve, reject) => {
        ffmpeg(tempIn)
          .noVideo()
          .audioCodec('libopus')
          .format('ogg')
          .on('end', resolve)
          .on('error', reject)
          .save(tempOut);
      });

      fs.unlinkSync(tempIn);
      const oggBuffer = fs.readFileSync(tempOut);
      fs.unlinkSync(tempOut);

      // 3) Enviar con Baileys como nota de voz
      await sendMessageToLead(leadId, oggBuffer, 'audio/ogg; codecs=opus', { ptt: true });

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error procesando audio:', err);
      return res.status(500).json({ error: 'No se pudo procesar el audio' });
    }
  }
);

// Arranca el servidor y conecta WhatsApp
app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  connectToWhatsApp().catch(err =>
    console.error("Error al conectar WhatsApp en startup:", err)
  );

  // Arranque inmediato de generación/envío de letras pendientes
  generateLetras().catch(err =>
    console.error("Error inicial en generateLetras:", err)
  );
  sendLetras().catch(err =>
    console.error("Error inicial en sendLetras:", err)
  );
});

// Scheduler: ejecuta las secuencias activas cada minuto
cron.schedule('* * * * *', () => {
  console.log('⏱️ processSequences:', new Date().toISOString());
  processSequences().catch(err => console.error('Error en processSequences:', err));
});

// Genera letras pendientes cada minuto
cron.schedule('* * * * *', () => {
  console.log('🖋️ generateLetras:', new Date().toISOString());
  generateLetras().catch(err => console.error('Error en generateLetras:', err));
});

// Envía letras pendientes cada minuto
cron.schedule('* * * * *', () => {
  console.log('📨 sendLetras:', new Date().toISOString());
  sendLetras().catch(err => console.error('Error en sendLetras:', err));
});
