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
import { db } from './firebaseAdmin.js'; // Usamos firebase-admin

// Importar integración con WhatsApp y funciones para PDF y estrategia
import { connectToWhatsApp, getLatestQR, getConnectionStatus, getWhatsAppSock, sendMessageToLead } from './whatsappService.js';
import { generarEstrategia } from './chatGpt.js';
import { generatePDF } from './utils/generatePDF.js';

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

// Endpoint para enviar mensaje de texto
app.get('/api/whatsapp/send/text', async (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone) {
      return res.status(400).json({ error: "El parámetro phone es requerido" });
    }
    const sock = getWhatsAppSock();
    if (!sock) {
      return res.status(500).json({ error: "No hay conexión activa con WhatsApp" });
    }
    let number = phone;
    if (!number.startsWith('521')) {
      number = `521${number}`;
    }
    const jid = `${number}@s.whatsapp.net`;

    const sendMessagePromise = sock.sendMessage(jid, { text: "Mensaje de prueba desde API (texto)" });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out')), 10000));
    await Promise.race([sendMessagePromise, timeout]);

    res.json({ success: true, message: "Mensaje de texto enviado" });
  } catch (error) {
    console.error("Error enviando mensaje de texto:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para enviar mensaje de imagen
app.get('/api/whatsapp/send/image', async (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone) {
      return res.status(400).json({ error: "El parámetro phone es requerido" });
    }
    const sock = getWhatsAppSock();
    if (!sock) {
      return res.status(500).json({ error: "No hay conexión activa con WhatsApp" });
    }
    let number = phone;
    if (!number.startsWith('521')) {
      number = `521${number}`;
    }
    const jid = `${number}@s.whatsapp.net`;

    await sock.sendMessage(jid, { image: { url: "https://via.placeholder.com/150" } });

    res.json({ success: true, message: "Mensaje de imagen enviado" });
  } catch (error) {
    console.error("Error enviando mensaje de imagen:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para enviar mensaje de audio
app.get('/api/whatsapp/send/audio', async (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone) {
      return res.status(400).json({ error: "El parámetro phone es requerido" });
    }
    const sock = getWhatsAppSock();
    if (!sock) {
      return res.status(500).json({ error: "No hay conexión activa con WhatsApp" });
    }
    let number = phone;
    if (!number.startsWith('521')) {
      number = `521${number}`;
    }
    const jid = `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, {
      audio: { url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3" },
      mimetype: "audio/mp4",
      fileName: "prueba.m4a",
      ptt: true
    });
    res.json({ success: true, message: "Mensaje de audio enviado" });
  } catch (error) {
    console.error("Error enviando mensaje de audio:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/whatsapp/send-message', async (req, res) => {
  const { leadId, message } = req.body;

  try {
    // Verificar si el lead tiene un número de WhatsApp registrado
    const leadDoc = await db.collection('leads').doc(leadId).get();
    if (!leadDoc.exists) {
      return res.status(404).json({ error: "Lead no encontrado" });
    }
    const leadData = leadDoc.data();
    const telefono = leadData.telefono;  // Usamos el campo "telefono" en lugar de "phone"
    
    // Verificar si el número ha cambiado
    let number = telefono;
    if (!number.startsWith('521')) {
      number = `521${number}`;
    }
    const jid = `${number}@s.whatsapp.net`;

    // Guardar el mensaje en Firebase también
    const newMessage = {
      content: message,
      sender: "business",
      timestamp: new Date(),
    };
    await db.collection('leads').doc(leadId).collection('messages').add(newMessage);
    
    // Enviar el mensaje a través de WhatsApp
    const result = await sendMessageToLead(leadId, message);
    
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
