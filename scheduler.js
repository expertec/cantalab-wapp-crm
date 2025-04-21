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
  return template.replace(/\{\{(\w+)\}\}/g, (_, field) => leadData[field] || _);
}

/**
 * Envía un mensaje de WhatsApp según su tipo: texto, audio o imagen.
 * Para audios, se envía como nota de voz (ptt) usando la URL directa,
 * lo que muestra la waveform nativa en WhatsApp.
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
        // Enviar como nota de voz usando URL para que WhatsApp muestre waveform
        await sock.sendMessage(jid, {
          audio: { url: contenidoFinal },
          ptt: true
        });
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
 * Lee triggers, calcula delays, envía mensajes y añade una notificación en Firebase.
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
        const startTime = new Date(seqActiva.startTime).getTime() + mensaje.delay * 60000;

        if (Date.now() >= startTime) {
          // Enviar el mensaje por WhatsApp
          await enviarMensaje(lead, mensaje);

          // Guardar notificación en Firebase (chat history)
          await db.collection('leads')
            .doc(lead.id)
            .collection('messages')
            .add({
              content: `Se envio el ${mensaje.type} de la secuencia ${trigger}`,
              sender: 'system',
              timestamp: new Date()
            });

          seqActiva.index += 1;
          actualizaciones = true;
        }
      }

      if (actualizaciones) {
        // Filtrar secuencias completadas
        const restantes = lead.secuenciasActivas.filter(seq => !seq.completed);
        await db.collection('leads').doc(lead.id).update({
          secuenciasActivas: restantes
        });
        console.log(`Lead ${lead.id} actualizado con nuevas secuencias`);
      }
    }
  } catch (error) {
    console.error("Error en processSequences:", error);
  }
}

/**
 * Revisa el último mensaje de cada lead y aplica etiquetas tras 24 h y 48 h.
 */
async function processTagTimeouts() {
  console.log("🔔 Revisando etiquetas por timeout...");
  try {
    // Cargar configuración global
    const cfgSnap = await db.collection('config').doc('appConfig').get();
    if (!cfgSnap.exists) return;
    const { tagAfter24h, tagAfter48h } = cfgSnap.data();

    // Si no hay etiquetas configuradas, saltar
    if (!tagAfter24h && !tagAfter48h) return;

    const leadsSnap = await db.collection('leads').get();
    const now = Date.now();

    for (const leadDoc of leadsSnap.docs) {
      const lead = { id: leadDoc.id, ...leadDoc.data() };

      // Obtener último mensaje
      const msgsSnap = await db.collection('leads')
        .doc(lead.id)
        .collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();
      if (msgsSnap.empty) continue;

      const lastMsg = msgsSnap.docs[0].data();
      const elapsedHrs = (now - lastMsg.timestamp.toDate().getTime()) / (1000 * 60 * 60);

      const etiquetas = Array.isArray(lead.etiquetas) ? [...lead.etiquetas] : [];
      let updated = false;

      // Después de 24 h
      if (tagAfter24h && elapsedHrs >= 24 && !etiquetas.includes(tagAfter24h)) {
        etiquetas.push(tagAfter24h);
        updated = true;
      }
      // Después de 48 h
      if (tagAfter48h && elapsedHrs >= 48 && !etiquetas.includes(tagAfter48h)) {
        etiquetas.push(tagAfter48h);
        updated = true;
      }

      if (updated) {
        await db.collection('leads').doc(lead.id).update({ etiquetas });
        console.log(`🗂️ Lead ${lead.id} - etiquetas actualizadas:`, etiquetas);
      }
    }
  } catch (error) {
    console.error("Error en processTagTimeouts:", error);
  }
}

export { processSequences, processTagTimeouts };
