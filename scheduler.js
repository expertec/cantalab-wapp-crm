// server/scheduler.js
import cron from 'node-cron';
import { db } from './firebaseAdmin.js';
import { getWhatsAppSock } from './whatsappService.js';
import fs from 'fs';
import path from 'path';
import { generarEstrategia } from './chatGpt.js';
import { generatePDF } from './utils/generatePDF.js';
import { uploadPDFToStorage } from './utils/uploadPDF.js';

function replacePlaceholders(template, leadData) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, fieldName) => {
    return leadData[fieldName] || match;
  });
}

async function enviarMensaje(lead, mensaje) {
  try {
    const sock = getWhatsAppSock();
    if (!sock) {
      console.error("No hay conexión activa con WhatsApp.");
      return;
    }
    let phone = lead.telefono;
    if (!phone.startsWith('521')) phone = `521${phone}`;
    const jid = `${phone}@s.whatsapp.net`;
    const contenidoFinal = replacePlaceholders(mensaje.contenido, lead);

    if (mensaje.type === "texto") {
      await sock.sendMessage(jid, { text: contenidoFinal });
    } else if (mensaje.type === "audio") {
      // Manejo de audio (omitido para brevedad, similar al código anterior)
      // ...
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

async function enviarPDFPlan(lead) {
  try {
    console.log(`Procesando PDF para el lead ${lead.id}`);
    let pdfUrl = lead.pdfEstrategia;
    if (!pdfUrl) {
      if (!lead.giro) {
        console.error("El lead no tiene campo 'giro', se asigna 'general'");
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
      pdfUrl = await uploadPDFToStorage(pdfFilePath, `estrategias/${path.basename(pdfFilePath)}`);
      if (!pdfUrl) {
        console.error("No se pudo subir el PDF a Storage.");
        return;
      }
      await db.collection('leads').doc(lead.id).update({ pdfEstrategia: pdfUrl });
      lead.pdfEstrategia = pdfUrl;
    }
    const sock = getWhatsAppSock();
    if (!sock) {
      console.error("No hay conexión activa con WhatsApp.");
      return;
    }
    let phone = lead.telefono;
    if (!phone.startsWith('521')) phone = `521${phone}`;
    const jid = `${phone}@s.whatsapp.net`;
    const pdfBuffer = fs.readFileSync(pdfUrl);
    await sock.sendMessage(jid, {
      document: pdfBuffer,
      fileName: `Estrategia-${lead.nombre}.pdf`,
      mimetype: "application/pdf"
    });
    console.log(`PDF de estrategia enviado a ${lead.telefono}`);
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
    console.log(`Se encontraron ${leadsSnapshot.size} leads con secuencias activas`);
    for (const docSnap of leadsSnapshot.docs) {
      const lead = { id: docSnap.id, ...docSnap.data() };
      if (!lead.secuenciasActivas || lead.secuenciasActivas.length === 0) continue;
      let actualizaciones = false;
      for (let seqActiva of lead.secuenciasActivas) {
        console.log(`Para lead ${lead.id} se procesa secuencia con trigger: "${seqActiva.trigger}"`);
        const secSnapshot = await db.collection('secuencias')
          .where('trigger', '==', seqActiva.trigger)
          .get();
        console.log(`Se encontraron ${secSnapshot.size} secuencias para trigger "${seqActiva.trigger}"`);
        if (secSnapshot.empty) {
          console.log(`No se encontró secuencia para trigger "${seqActiva.trigger}"`);
          continue;
        }
        const secuencia = secSnapshot.docs[0].data();
        const mensajes = secuencia.messages;
        if (seqActiva.index >= mensajes.length) {
          console.log(`Secuencia completada para lead ${lead.id}`);
          seqActiva.completed = true;
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
      // Filtramos secuencias completadas
      const nuevasSecuencias = lead.secuenciasActivas.filter(seq => !seq.completed);
      if (actualizaciones) {
        await db.collection('leads').doc(lead.id).update({
          secuenciasActivas: nuevasSecuencias
        });
        console.log(`Lead ${lead.id} actualizado con nuevas secuencias`);
      }
    }
  } catch (error) {
    console.error("Error en processSequences:", error);
  }
}

cron.schedule('* * * * *', () => {
  processSequences();
});

export { processSequences };
