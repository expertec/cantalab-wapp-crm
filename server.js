import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

// Importar Firebase Admin
import { db } from './firebaseAdmin.js';  // Usamos firebase-admin

// Importar integración con WhatsApp y funciones para PDF y estrategia
import { connectToWhatsApp, getLatestQR, getConnectionStatus, getWhatsAppSock } from './whatsappService.js';
import { sendMessage } from './handlers/mensajeSender.js';  // Importamos el handler de enviar mensajes
import { receiveMessage } from './handlers/mensajeReceiver.js';  // Importamos el handler de recibir mensajes

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());

// Endpoint de depuración para verificar el archivo secreto de Firebase
app.get('/api/debug-env', (req, res) => {
  const firebaseKeyPath = path.join('/etc/secrets', 'serviceAccountKey.json');
  const exists = fs.existsSync(firebaseKeyPath);
  res.json({
    archivoSecreto: exists ? "Archivo de llave de Firebase OK" : "No se encontró el archivo secreto",
    ruta: firebaseKeyPath
  });
});

// Endpoint para consultar el estado de WhatsApp (QR y conexión)
app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    status: getConnectionStatus(),
    qr: getLatestQR()
  });
});

// Endpoint para iniciar la conexión con WhatsApp
app.get('/api/whatsapp/connect', async (req, res) => {
  try {
    await connectToWhatsApp();
    res.json({
      status: "Conectado",
      message: "Conexión iniciada. Espera el QR si aún no estás conectado."
    });
  } catch (error) {
    console.error("Error al conectar con WhatsApp:", error);
    res.status(500).json({
      status: "Error",
      message: "Error al conectar con WhatsApp."
    });
  }
});

// Endpoint para enviar mensaje desde el frontend
app.post('/api/whatsapp/send-message', async (req, res) => {
  const { leadId, message } = req.body;

  try {
    console.log(`Received message for leadId: ${leadId}`);
    
    // Verificar si el lead tiene un número de WhatsApp registrado
    const leadDoc = await db.collection('leads').doc(leadId).get();
    if (!leadDoc.exists) {
      console.error(`Lead with ID ${leadId} not found`);
      return res.status(404).json({ error: "Lead no encontrado" });
    }

    const leadData = leadDoc.data();
    console.log(`Lead data: ${JSON.stringify(leadData)}`);

    const telefono = leadData.telefono;  // Usamos el campo "telefono" en lugar de "phone"
    console.log(`Telefono for leadId ${leadId}: ${telefono}`);
    
    // Verificar si el número ha cambiado
    let number = telefono;
    if (!number.startsWith('521')) {
      number = `521${number}`;
    }
    const jid = `${number}@s.whatsapp.net`;
    console.log(`Sending message to: ${jid}`);

    // Guardar el mensaje en Firebase también
    const newMessage = {
      content: message,
      sender: "business",
      timestamp: new Date(),
    };
    console.log(`Saving message to Firebase: ${JSON.stringify(newMessage)}`);
    await db.collection('leads').doc(leadId).collection('messages').add(newMessage);

    // Usamos el handler de mensajeSender.js para enviar el mensaje a WhatsApp
    const result = await sendMessage(leadId, message);
    console.log("WhatsApp message sent:", result);
    
    res.json(result);
  } catch (error) {
    console.error("Error enviando mensaje de WhatsApp:", error);
    res.status(500).json({ error: error.message });
  }
});

// Función para procesar la secuencia de mensajes
async function processSequences() {
  // Código de tu lógica de secuencias, si lo tienes
}

cron.schedule('* * * * *', () => {
  processSequences();
});

app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  connectToWhatsApp().catch(err => console.error("Error al conectar WhatsApp en startup:", err));
});
