// server/scheduler.js
import cron from 'node-cron';
import { db } from './firebaseAdmin.js';
import { getWhatsAppSock } from './whatsappService.js';
import axios from 'axios';
import path from 'path';

/**
 * Reemplaza placeholders en plantillas de texto.
 * {{campo}} se sustituye por leadData.campo si existe.
 */
function replacePlaceholders(template, leadData) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, fieldName) => {
    return leadData[fieldName] || match;
  });
}

/**
 * Envía un mensaje de WhatsApp según su tipo: texto, audio o imagen.
 */
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

    switch (mensaje.type) {
      case 'texto':
        await sock.sendMessage(jid, { text: contenidoFinal });
        break;

        case 'audio':
  try {
    // Envía como nota de voz usando la URL directa para que WhatsApp muestre la waveform nativa
    await sock.sendMessage(jid, {
      audio: { url: contenidoFinal },
      ptt: true
    });
  } catch (err) {
    console.error("Error al enviar audio como nota de voz:", err);
  }
  break;

        

      case 'imagen':
        await sock.sendMessage(jid, { image: { url: contenidoFinal } });
        break;

      default:
        console.warn(`Tipo de mensaje desconocido: ${mensaje.type}`);
    }

    console.log(`Mensaje de tipo "${mensaje.type}" enviado a ${lead.telefono}`);
  } catch (error) {
    console.error("Error al enviar mensaje:", error);
  }
}

/**
 * Procesa las secuencias activas de cada lead.
 * Lee triggers, calcula delays y envía mensajes programados.
 */
async function processSequences() {
  console.log("Ejecutando scheduler de secuencias...");
  try {
    const leadsSnapshot = await db.collection('leads')
      .where('secuenciasActivas', '!=', null)
      .get();
    console.log(`Se encontraron ${leadsSnapshot.size} leads con secuencias activas`);

    for (const docSnap of leadsSnapshot.docs) {
      const lead = { id: docSnap.id, ...docSnap.data() };
      if (!Array.isArray(lead.secuenciasActivas) || lead.secuenciasActivas.length === 0) continue;

      let actualizaciones = false;

      for (const seqActiva of lead.secuenciasActivas) {
        const trigger = seqActiva.trigger;
        const seqSnapshot = await db.collection('secuencias')
          .where('trigger', '==', trigger)
          .get();
        if (seqSnapshot.empty) continue;

        const secuencia = seqSnapshot.docs[0].data();
        const mensajes = secuencia.messages;
        if (seqActiva.index >= mensajes.length) {
          seqActiva.completed = true;
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
        // Filtrar secuencias completadas
        const nuevas = lead.secuenciasActivas.filter(seq => !seq.completed);
        await db.collection('leads').doc(lead.id).update({
          secuenciasActivas: nuevas
        });
        console.log(`Lead ${lead.id} actualizado con nuevas secuencias`);
      }
    }
  } catch (error) {
    console.error("Error en processSequences:", error);
  }
}

export { processSequences };
