const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { db } = require('./firebaseAdmin');
const { getWhatsAppSock } = require('./whatsappService');
const { generarEstrategia } = require('./chatGpt');
const { generatePDF } = require('./utils/generatePDF');
const { uploadPDFToStorage } = require('./utils/uploadPDF'); 

function replacePlaceholders(template, leadData) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, fieldName) => {
    return leadData[fieldName] || match;
  });
}

/**
 * Función para enviar mensaje vía WhatsApp.
 * Se diferencia el caso de pdf: si es "pdfChatGPT" se lee el campo pdfEstrategia.
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
    const contenidoFinal = replacePlaceholders(mensaje.contenido, lead);

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
          mimetype: 'audio/mp4',
          fileName: 'output.m4a',
          ptt: true
        };
        await sock.sendMessage(jid, audioMsg);
      } catch (err) {
        console.error("Error al descargar o enviar audio:", err);
      }
    } else if (mensaje.type === "imagen") {
      await sock.sendMessage(jid, { image: { url: contenidoFinal } });
    } else if (mensaje.type === "pdfChatGPT") {
      await enviarPDFPlan(lead);
    }
    console.log(`Mensaje de tipo "${mensaje.type}" enviado a ${lead.telefono}`);
  } catch (error) {
    console.error("Error al enviar mensaje:", error);
  }
}

/**
 * Función que se encarga de enviar el PDF de la estrategia.
 * - Genera la estrategia y el PDF si aún no existe en el lead.
 * - Envía el PDF por WhatsApp.
 * - Actualiza el lead con el campo 'pdfEstrategia' y cambia la etiqueta a "planEnviado".
 */
async function enviarPDFPlan(lead) {
  try {
    console.log(`Procesando PDF para el lead ${lead.id}`);
    let pdfUrl = lead.pdfEstrategia;
    if (!pdfUrl) {
      if (!lead.giro) {
        console.error("El lead no tiene campo 'giro', se asigna 'general'");
        lead.giro = "general";
      }
      // Genera la estrategia personalizada
      const strategyText = await generarEstrategia(lead);
      if (!strategyText) {
        console.error("No se pudo generar la estrategia.");
        return;
      }
      // Genera el PDF usando generatePDF
      const pdfFilePath = await generatePDF(lead, strategyText);
      if (!pdfFilePath) {
        console.error("No se generó el PDF, pdfFilePath es nulo.");
        return;
      }
      console.log("PDF generado en:", pdfFilePath);
      // Sube el PDF a Storage y obtiene la URL pública
      pdfUrl = await uploadPDFToStorage(pdfFilePath, `estrategias/${path.basename(pdfFilePath)}`);
      if (!pdfUrl) {
        console.error("No se pudo subir el PDF a Storage.");
        return;
      }
      // Actualiza el lead con la URL del PDF
      await db.collection('leads').doc(lead.id).update({ pdfEstrategia: pdfUrl });
      lead.pdfEstrategia = pdfUrl;
    }
    // Envía el PDF vía WhatsApp
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
    const pdfBuffer = fs.readFileSync(pdfUrl);
    await sock.sendMessage(jid, {
      document: pdfBuffer,
      fileName: `Estrategia-${lead.nombre}.pdf`,
      mimetype: "application/pdf"
    });
    console.log(`PDF de estrategia enviado a ${lead.telefono}`);
    // Actualiza la etiqueta del lead a "planEnviado"
    const currentData = (await db.collection('leads').doc(lead.id).get()).data();
    const etiquetas = currentData.etiquetas || [];
    if (!etiquetas.includes("planEnviado")) {
      etiquetas.push("planEnviado");
      await db.collection('leads').doc(lead.id).update({ etiquetas });
    }
  } catch (err) {
    console.error("Error al enviar el PDF del plan:", err);
  }
}

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
      }
    });
  } catch (error) {
    console.error("Error en processSequences:", error);
  }
}

cron.schedule('* * * * *', () => {
  processSequences();
});

const port = process.env.PORT || 3001;
const express = require('express');
const app = express();

app.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
});
