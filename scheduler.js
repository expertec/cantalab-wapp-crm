// server/scheduler.js
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
 * Envía un mensaje de WhatsApp según su tipo.
 */
async function enviarMensaje(lead, mensaje) {
  const sock = getWhatsAppSock();
  if (!sock) return console.error("No hay conexión activa con WhatsApp.");

  let phone = lead.telefono;
  if (!phone.startsWith('521')) phone = `521${phone}`;
  const jid = `${phone}@s.whatsapp.net`;

  switch (mensaje.type) {
    case 'texto': {
      if (mensaje.contenido.includes('{{telefono}}') || mensaje.contenido.includes('{{nombre}}')) {
        return;
      }
      const text = replacePlaceholders(mensaje.contenido, lead).trim();
      if (text) await sock.sendMessage(jid, { text });
      break;
    }
    case 'formulario': {
      const base = process.env.FRONTEND_URL || 'http://localhost:3000';
      const nombreEnc = encodeURIComponent(lead.nombre || '');
      const url = `${base}/formulario-cancion?phone=${phone}&name=${nombreEnc}`;
      const intro = (mensaje.contenido || '').replace(/\r?\n/g, ' ').trim();
      const text = intro ? `${intro} ${url}` : url;
      await sock.sendMessage(jid, { text });
      break;
    }
    case 'audio':
      await sock.sendMessage(jid, {
        audio: { url: replacePlaceholders(mensaje.contenido, lead) },
        ptt: true
      });
      break;
    case 'imagen':
      await sock.sendMessage(jid, {
        image: { url: replacePlaceholders(mensaje.contenido, lead) }
      });
      break;
    default:
      console.warn(`Tipo de mensaje desconocido: ${mensaje.type}`);
  }

  console.log(`Mensaje de tipo "${mensaje.type}" enviado a ${lead.telefono}`);
}

/**
 * Recorre y ejecuta las secuencias activas.
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
      if (!Array.isArray(lead.secuenciasActivas) || !lead.secuenciasActivas.length) continue;

      let updated = false;

      for (const seq of lead.secuenciasActivas) {
        const { trigger, startTime, index } = seq;
        const seqSnap = await db
          .collection('secuencias')
          .where('trigger', '==', trigger)
          .get();
        if (seqSnap.empty) continue;

        const mensajes = seqSnap.docs[0].data().messages;
        if (index >= mensajes.length) {
          seq.completed = true;
          updated = true;
          continue;
        }

        const mensaje = mensajes[index];
        const envioAt = new Date(startTime).getTime() + mensaje.delay * 60000;
        if (Date.now() < envioAt) continue;

        await enviarMensaje(lead, mensaje);
        await db
          .collection('leads')
          .doc(lead.id)
          .collection('messages')
          .add({
            content: `Se envió el ${mensaje.type} de la secuencia ${trigger}`,
            sender: 'system',
            timestamp: new Date()
          });

        seq.index++;
        updated = true;
      }

      if (updated) {
        const restantes = lead.secuenciasActivas.filter(s => !s.completed);
        await db.collection('leads').doc(lead.id).update({ secuenciasActivas: restantes });
      }
    }
  } catch (err) {
    console.error("Error en processSequences:", err);
  }
}

/**
 * Revisa el último mensaje de cada lead y aplica etiquetas tras 24h/48h.
 */
async function processTagTimeouts() {
  console.log("🔔 Revisando etiquetas por timeout...");
  try {
    const cfgSnap = await db.collection('config').doc('appConfig').get();
    if (!cfgSnap.exists) return;
    const { tagAfter24h, tagAfter48h } = cfgSnap.data();
    if (!tagAfter24h && !tagAfter48h) return;

    const now = Date.now();
    const leadsSnap = await db.collection('leads').get();

    for (const d of leadsSnap.docs) {
      const lead = { id: d.id, ...d.data() };
      const msgsSnap = await db
        .collection('leads')
        .doc(lead.id)
        .collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();
      if (msgsSnap.empty) continue;

      const last = msgsSnap.docs[0].data();
      const hrs = (now - last.timestamp.toDate().getTime()) / 36e5;
      const tags = Array.isArray(lead.etiquetas) ? [...lead.etiquetas] : [];
      let changed = false;

      if (tagAfter24h && hrs >= 24 && !tags.includes(tagAfter24h)) {
        tags.push(tagAfter24h); changed = true;
      }
      if (tagAfter48h && hrs >= 48 && !tags.includes(tagAfter48h)) {
        tags.push(tagAfter48h); changed = true;
      }
      if (changed) {
        await db.collection('leads').doc(lead.id).update({ etiquetas: tags });
      }
    }
  } catch (err) {
    console.error("Error en processTagTimeouts:", err);
  }
}

export { processSequences, processTagTimeouts };
