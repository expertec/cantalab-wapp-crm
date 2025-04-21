// server/scheduler.js
import cron from 'node-cron';
import { db } from './firebaseAdmin.js';
import { getWhatsAppSock } from './whatsappService.js';

/**
 * Reemplaza placeholders en plantillas de texto.
 * {{campo}} se sustituye por leadData.campo si existe.
 */
function replacePlaceholders(template, leadData) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, field) => leadData[field] || _);
}

/**
 * Envía un mensaje de WhatsApp según su tipo: texto, formulario, audio o imagen.
 * Para audios, se envía como nota de voz (ptt) usando la URL directa.
 */
async function enviarMensaje(lead, mensaje) {
  try {
    const sock = getWhatsAppSock();
    if (!sock) {
      console.error("No hay conexión activa con WhatsApp.");
      return;
    }

    // Construir JID
    let phone = lead.telefono;
    if (!phone.startsWith('521')) phone = `521${phone}`;
    const jid = `${phone}@s.whatsapp.net`;

    switch (mensaje.type) {
      case 'texto': {
        // Si el template usa {{telefono}} o {{nombre}}, lo omitimos
        if (mensaje.contenido.includes('{{telefono}}') || mensaje.contenido.includes('{{nombre}}')) {
          return;
        }
        const text = replacePlaceholders(mensaje.contenido, lead).trim();
        if (text) await sock.sendMessage(jid, { text });
        break;
      }
      case 'formulario': {
        const base = process.env.FRONTEND_URL || 'http://localhost:3000';
        const leadPhone = phone;
        const nombreEnc = encodeURIComponent(lead.nombre || '');
        const url = `${base}/formulario-cancion?phone=${leadPhone}&name=${nombreEnc}`;

        const intro = (mensaje.contenido || '').replace(/\r?\n/g, ' ').trim();
        const text = intro ? `${intro} ${url}` : url;
        await sock.sendMessage(jid, { text });
        break;
      }
      case 'audio': {
        await sock.sendMessage(jid, {
          audio: { url: replacePlaceholders(mensaje.contenido, lead) },
          ptt: true
        });
        break;
      }
      case 'imagen': {
        await sock.sendMessage(jid, {
          image: { url: replacePlaceholders(mensaje.contenido, lead) }
        });
        break;
      }
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
 * Lee triggers, calcula delays, envía mensajes y guarda notificaciones en Firebase.
 */
async function processSequences() {
  console.log("Ejecutando scheduler de secuencias...");
  try {
    const leadsSnapshot = await db
      .collection('leads')
      .where('secuenciasActivas', '!=', null)
      .get();

    for (const docSnap of leadsSnapshot.docs) {
      const lead = { id: docSnap.id, ...docSnap.data() };
      if (!Array.isArray(lead.secuenciasActivas) || lead.secuenciasActivas.length === 0) continue;

      let actualizaciones = false;

      for (const seqActiva of lead.secuenciasActivas) {
        const trigger = seqActiva.trigger;
        const seqSnapshot = await db
          .collection('secuencias')
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
        const envioAt = new Date(seqActiva.startTime).getTime() + mensaje.delay * 60000;

        if (Date.now() >= envioAt) {
          await enviarMensaje(lead, mensaje);

          // Guardar notificación en Firebase
          await db
            .collection('leads')
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
        const restantes = lead.secuenciasActivas.filter(seq => !seq.completed);
        await db.collection('leads').doc(lead.id).update({ secuenciasActivas: restantes });
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
    const cfgSnap = await db.collection('config').doc('appConfig').get();
    if (!cfgSnap.exists) return;
    const { tagAfter24h, tagAfter48h } = cfgSnap.data();
    if (!tagAfter24h && !tagAfter48h) return;

    const leadsSnap = await db.collection('leads').get();
    const now = Date.now();

    for (const leadDoc of leadsSnap.docs) {
      const lead = { id: leadDoc.id, ...leadDoc.data() };
      const msgsSnap = await db
        .collection('leads')
        .doc(lead.id)
        .collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();
      if (msgsSnap.empty) continue;

      const lastMsg = msgsSnap.docs[0].data();
      const hrs = (now - lastMsg.timestamp.toDate().getTime()) / 36e5;
      const etiquetas = Array.isArray(lead.etiquetas) ? [...lead.etiquetas] : [];
      let updated = false;

      if (tagAfter24h && hrs >= 24 && !etiquetas.includes(tagAfter24h)) {
        etiquetas.push(tagAfter24h);
        updated = true;
      }
      if (tagAfter48h && hrs >= 48 && !etiquetas.includes(tagAfter48h)) {
        etiquetas.push(tagAfter48h);
        updated = true;
      }
      if (updated) {
        await db.collection('leads').doc(lead.id).update({ etiquetas });
      }
    }
  } catch (error) {
    console.error("Error en processTagTimeouts:", error);
  }
}


// Cron: ejecutar processTagTimeouts cada hora (minuto 0)
cron.schedule('0 * * * *', () => {
  processTagTimeouts().catch(err => console.error(err));
});

export { processSequences, processTagTimeouts };
