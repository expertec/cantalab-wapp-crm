// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
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

    // Estándar de WhatsApp: si no empieza con 521, lo agregamos
    let number = telefono;
    if (!number.startsWith('521')) {
      number = `521${number}`;
    }
    const jid = `${number}@s.whatsapp.net`;
    console.log(`Enviando mensaje a JID: ${jid}`);

    // Guardamos el mensaje en Firestore
    const newMessage = {
      content: message,
      sender: "business",
      timestamp: new Date(),
    };
    await leadRef.collection('messages').add(newMessage);

    // Actualizamos también lastMessageAt para poder ordenar luego los leads
    await leadRef.update({ lastMessageAt: newMessage.timestamp });

    // Enviamos el mensaje por WhatsApp
    const result = await sendMessageToLead(number, message);
    console.log("WhatsApp message sent:", result);

    return res.json(result);
  } catch (error) {
    console.error("Error enviando mensaje de WhatsApp:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Endpoint para marcar todos los mensajes de un lead como leídos
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

// Arranca el servidor y conecta WhatsApp
app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  connectToWhatsApp().catch(err =>
    console.error("Error al conectar WhatsApp en startup:", err)
  );
});
