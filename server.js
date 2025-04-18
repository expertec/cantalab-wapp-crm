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
import { db } from './firebaseAdmin.js';

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

// Endpoint para enviar mensaje desde el frontend
app.post('/api/whatsapp/send-message', async (req, res) => {
  const { leadId, message } = req.body;

  try {
    const result = await sendMessageToLead(leadId, message);
    res.json(result);
  } catch (error) {
    console.error("Error enviando mensaje de WhatsApp:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Función para enviar mensajes según el tipo.
 * Se ha incluido el caso "pdfChatGPT" que genera, guarda y envía el PDF.
 */
async function enviarMensaje(lead, mensaje) {
  try {
    const sock = getWhatsAppSock();
    if (!sock) {
      console.error("No hay conexión activa con WhatsApp.");
      return;
    }
    let phone = lead.telefono;
    if (!phone.startsWith('521')) {
      phone = `521${phone}`;
    }
    const jid = `${phone}@s.whatsapp.net`;
    const contenidoFinal = mensaje.contenido;

    if (mensaje.type === "texto") {
      await sock.sendMessage(jid, { text: contenidoFinal });
    } else if (mensaje.type === "audio") {
      try {
        const response = await axios.get(contenidoFinal, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(response.data, 'binary');
        if (audioBuffer.length === 0) {
          console.error(`Error: El archivo descargado está vacío.`);
          return;
        }
        const audioMsg = {
          audio: audioBuffer,
          ptt: true
        };
        await sock.sendMessage(jid, audioMsg);
      } catch (err) {
        console.error("Error al descargar o enviar audio:", err);
      }
    } else if (mensaje.type === "imagen") {
      await sock.sendMessage(jid, { image: { url: contenidoFinal } });
    } else if (mensaje.type === "pdfChatGPT") {
      await procesarMensajePDFChatGPT(lead);
    }
  } catch (error) {
    console.error("Error al enviar mensaje:", error);
  }
}

/**
 * Función que procesa el mensaje de tipo pdfChatGPT:
 * - Genera la estrategia y el PDF si aún no existe en el lead.
 * - Envía el PDF por WhatsApp.
 * - Actualiza el lead con el campo 'pdfEstrategia' y cambia la etiqueta a "planEnviado".
 */
async function procesarMensajePDFChatGPT(lead) {
  try {
    if (!lead.pdfEstrategia) {
      const strategyText = await generarEstrategia(lead);
      if (!strategyText) return;
      const pdfFilePath = await generatePDF(lead, strategyText);
      if (!pdfFilePath) return;
      await db.collection('leads').doc(lead.id).update({ pdfEstrategia: pdfFilePath });
      lead.pdfEstrategia = pdfFilePath;
    }

    const sock = getWhatsAppSock();
    if (!sock) return;

    let phone = lead.telefono;
    if (!phone.startsWith('521')) phone = `521${phone}`;
    const jid = `${phone}@s.whatsapp.net`;
    const pdfBuffer = fs.readFileSync(lead.pdfEstrategia);
    await sock.sendMessage(jid, {
      document: pdfBuffer,
      fileName: `Estrategia-${lead.nombre}.pdf`,
      mimetype: "application/pdf"
    });

    await db.collection('leads').doc(lead.id).update({ etiqueta: "planEnviado" });
  } catch (err) {
    console.error("Error procesando mensaje pdfChatGPT:", err);
  }
}

cron.schedule('* * * * *', () => {
  processSequences();
});

app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  connectToWhatsApp().catch(err => console.error("Error al conectar WhatsApp en startup:", err));
});
