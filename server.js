// server/server.js
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
import { 
  connectToWhatsApp, 
  getLatestQR, 
  getConnectionStatus, 
  getWhatsAppSock 
} from './whatsappService.js';
import { generarEstrategia } from './chatGpt.js';
import { generatePDF } from './utils/generatePDF.js';

const app = express();
const port = process.env.PORT || 3001;
const businessId = process.env.BUSINESS_ID; // Ejemplo: "miNegocio123"

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
    status: getConnectionStatus(businessId),
    qr: getLatestQR(businessId)
  });
});

// Endpoint para iniciar la conexión con WhatsApp, usando el businessId
app.get('/api/whatsapp/connect', async (req, res) => {
  try {
    await connectToWhatsApp(businessId);
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
    const sock = getWhatsAppSock(businessId);
    if (!sock) {
      return res.status(500).json({ error: "No hay conexión activa con WhatsApp" });
    }
    let number = phone;
    if (!number.startsWith('521')) {
      number = `521${number}`;
    }
    const jid = `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: "Mensaje de prueba desde API (texto)" });
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
    const sock = getWhatsAppSock(businessId);
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
    const sock = getWhatsAppSock(businessId);
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

/**
 * Función para enviar mensajes según el tipo.
 * Caso especial "pdfChatGPT" se maneja de forma similar.
 */
async function enviarMensaje(lead, mensaje) {
  try {
    const sock = getWhatsAppSock(businessId);
    if (!sock) {
      console.error("No hay conexión activa con WhatsApp.");
      return;
    }
    let phone = lead.telefono;
    if (!phone.startsWith('521')) {
      phone = `521${phone}`;
    }
    const jid = `${phone}@s.whatsapp.net`;
    const contenidoFinal = mensaje.contenido; // Se asume que ya se han aplicado los placeholders

    if (mensaje.type === "texto") {
      await sock.sendMessage(jid, { text: contenidoFinal });
    } else if (mensaje.type === "audio") {
      try {
        console.log(`Descargando audio desde: ${contenidoFinal} para el lead ${lead.id}`);
        const response = await axios.get(contenidoFinal, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(response.data, 'binary');
        console.log(`Audio descargado. Tamaño: ${audioBuffer.length} bytes para el lead ${lead.id}`);
        if (audioBuffer.length === 0) {
          console.error(`Error: El archivo descargado está vacío para el lead ${lead.id}`);
          return;
        }
        const audioMsg = {
          audio: audioBuffer,
          mimetype: 'audio/mp4', // o 'audio/m4a'
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
    console.log(`Mensaje de tipo "${mensaje.type}" enviado a ${lead.telefono}`);
  } catch (error) {
    console.error("Error al enviar mensaje:", error);
  }
}

/**
 * Función que procesa el mensaje de tipo pdfChatGPT:
 * - Genera la estrategia y el PDF si no existe.
 * - Envía el PDF por WhatsApp.
 * - Actualiza el lead con el campo 'pdfEstrategia' y etiqueta "planEnviado".
 */
async function procesarMensajePDFChatGPT(lead) {
  try {
    console.log(`Procesando PDF ChatGPT para el lead ${lead.id}`);
    if (!lead.pdfEstrategia) {
      if (!lead.giro) {
        console.error("El lead no contiene el campo 'giro'. Se asigna 'general'.");
        lead.giro = "general";
      }
      const strategyText = await generarEstrategia(lead);
      if (!strategyText) {
        console.error("No se pudo generar la estrategia.");
        return;
      }
      const pdfFilePath = await generatePDF(lead, strategyText);
      if (!pdfFilePath) {
        console.error("No se generó el PDF, pdfFilePath es nulo.");
        return;
      }
      console.log("PDF generado en:", pdfFilePath);
      await db.collection('leads').doc(lead.id).update({ pdfEstrategia: pdfFilePath });
      lead.pdfEstrategia = pdfFilePath;
    }
    const sock = getWhatsAppSock(businessId);
    if (!sock) {
      console.error("No hay conexión activa con WhatsApp.");
      return;
    }
    let phone = lead.telefono;
    if (!phone.startsWith('521')) {
      phone = `521${phone}`;
    }
    const jid = `${phone}@s.whatsapp.net`;
    const pdfBuffer = fs.readFileSync(lead.pdfEstrategia);
    await sock.sendMessage(jid, {
      document: pdfBuffer,
      fileName: `Estrategia-${lead.nombre}.pdf`,
      mimetype: "application/pdf"
    });
    console.log(`PDF de estrategia enviado a ${lead.telefono}`);
    await db.collection('leads').doc(lead.id).update({ etiqueta: "planEnviado" });
  } catch (err) {
    console.error("Error procesando mensaje pdfChatGPT:", err);
  }
}

/**
 * Función que procesa las secuencias activas para cada lead.
 */
async function processSequences() {
  console.log("Ejecutando scheduler de secuencias...");
  try {
    const leadsSnapshot = await db.collection('leads')
      .where('secuenciasActivas', '!=', null)
      .get();
      
    leadsSnapshot.forEach(async (docSnap) => {
      const lead = { id: docSnap.id, ...docSnap.data() };
      if (!lead.secuenciasActivas || lead.secuenciasActivas.length === 0) return;
      let actualizaciones = false;
      for (let i = 0; i < lead.secuenciasActivas.length; i++) {
        const seqActiva = lead.secuenciasActivas[i];
        const secSnapshot = await db.collection('secuencias')
          .where('trigger', '==', seqActiva.trigger)
          .get();
        if (secSnapshot.empty) continue;
        const secuencia = secSnapshot.docs[0].data();
        const mensajes = secuencia.messages;
        if (seqActiva.index >= mensajes.length) {
          lead.secuenciasActivas[i] = null;
          actualizaciones = true;
          continue;
        }
        const mensaje = mensajes[seqActiva.index];
        const startTime = new Date(seqActiva.startTime);
        const envioProgramado = new Date(startTime.getTime() + mensaje.delay * 60000);
        console.log(`Lead ${lead.id} - mensaje[${seqActiva.index}]: delay=${mensaje.delay} min, programado a: ${envioProgramado.toLocaleString()}, hora actual: ${new Date().toLocaleString()}`);
        if (Date.now() >= envioProgramado.getTime()) {
          await enviarMensaje(lead, mensaje);
          seqActiva.index += 1;
          actualizaciones = true;
        }
      }
      if (actualizaciones) {
        lead.secuenciasActivas = lead.secuenciasActivas.filter(item => item !== null);
        await db.collection('leads').doc(lead.id).update({
          secuenciasActivas: lead.secuenciasActivas
        });
        console.log(`Lead ${lead.id} actualizado con nuevas secuencias`);
      }
    });
  } catch (error) {
    console.error("Error en processSequences:", error);
  }
}

cron.schedule('* * * * *', () => {
  processSequences();
});

app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  // Inicia la conexión de WhatsApp para el negocio usando el businessId de la variable de entorno
  connectToWhatsApp(businessId).catch(err =>
    console.error("Error al conectar WhatsApp en startup:", err)
  );
});
