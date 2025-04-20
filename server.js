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

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());

app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    status: getConnectionStatus(),
    qr: getLatestQR()
  });
});

app.post('/api/whatsapp/send-message', async (req, res) => {
  const { leadId, message } = req.body;

  try {
    console.log(`Received message for leadId: ${leadId}`);
    const leadDoc = await db.collection('leads').doc(leadId).get();
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

    // Guardamos en Firebase (opcional duplicado con front-end)
    const newMessage = {
      content: message,
      sender: "business",
      timestamp: new Date(),
    };
    await db.collection('leads').doc(leadId).collection('messages').add(newMessage);

    // --- FIX: pasamos el número, NO el leadId ---
    const result = await sendMessageToLead(number, message);
    console.log("WhatsApp message sent:", result);

    return res.json(result);
  } catch (error) {
    console.error("Error enviando mensaje de WhatsApp:", error);
    return res.status(500).json({ error: error.message });
  }
});

cron.schedule('* * * * *', () => {
  // tu lógica de secuencias...
});

app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  connectToWhatsApp().catch(err =>
    console.error("Error al conectar WhatsApp en startup:", err)
  );
});
