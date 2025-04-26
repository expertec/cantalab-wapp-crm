// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

import { db } from './firebaseAdmin.js';
import {
  connectToWhatsApp,
  getLatestQR,
  getConnectionStatus,
  sendMessageToLead
} from './whatsappService.js';
import { processSequences } from './scheduler.js';

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

// Endpoint para enviar mensaje de WhatsApp
app.post('/api/whatsapp/send-message', async (req, res) => {
  const { leadId, message } = req.body;

  try {
    console.log(`Received message for leadId: ${leadId}`);
    const leadRef = db.collection('leads').doc(leadId);
    const leadDoc = await leadRef.get();
    if (!leadDoc.exists) {
      return res.status(404).json({ error: "Lead no encontrado" });
    }

    const { telefono } = leadDoc.data();
    console.log(`Telefono for leadId ${leadId}: ${telefono}`);

    // Aseguramos el prefijo "521"
    let number = telefono;
    if (!number.startsWith('521')) {
      number = `521${number}`;
    }

    // Enviamos el mensaje por WhatsApp y dejamos que whatsappService
    // sea el único que escriba en Firestore para evitar duplicados.
    const result = await sendMessageToLead(number, message);
    console.log("WhatsApp message sent:", result);

    return res.json(result);
  } catch (error) {
    console.error("Error enviando mensaje de WhatsApp:", error);
    return res.status(500).json({ error: error.message });
  }
});

// (Opcional) Endpoint para marcar todos los mensajes de un lead como leídos
app.post('/api/whatsapp/mark-read', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) {
    return res.status(400).json({ error: "Falta leadId en el body" });
  }
  try {
    await db.collection('leads')
            .doc(leadId)
            .update({ unreadCount: 0 });
    return res.json({ success: true });
  } catch (err) {
    console.error("Error marcando como leídos:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Scheduler: ejecuta las secuencias activas cada minuto
cron.schedule('* * * * *', () => {
  console.log('Ejecutando processSequences a las', new Date().toLocaleTimeString());
  processSequences();
});

// Generar letras pendientes cada 5 minutos
cron.schedule('*/5 * * * *', () => {
  console.log('🖋️ Generando letras:', new Date());
  generateLetras();
});

// Enviar letras ya generadas cada 5 minutos
cron.schedule('*/5 * * * *', () => {
  console.log('📨 Enviando letras:', new Date());
  sendLetras();
});

// Arranca el servidor y conecta WhatsApp
app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  connectToWhatsApp().catch(err =>
    console.error("Error al conectar WhatsApp en startup:", err)
  );
});

