// src/server/scheduler.js
import { db } from './firebaseAdmin.js';
import { getWhatsAppSock } from './whatsappService.js';
import admin from 'firebase-admin';
import { Configuration, OpenAIApi } from 'openai';

const { FieldValue } = admin.firestore;

// Asegúrate de que la API key esté definida
if (!process.env.OPENAI_API_KEY) {
  throw new Error("Falta la variable de entorno OPENAI_API_KEY");
}

// Configuración de OpenAI
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

/**
 * Reemplaza placeholders en plantillas de texto.
 * {{campo}} se sustituye por leadData.campo si existe.
 */
function replacePlaceholders(template, leadData) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, field) => leadData[field] || '');
}

/**
 * Envía un mensaje de WhatsApp según su tipo.
 */
async function enviarMensaje(lead, mensaje) {
  try {
    const sock = getWhatsAppSock();
    if (!sock) return;

    let phone = lead.telefono;
    if (!phone.startsWith('521')) phone = `521${phone}`;
    const jid = `${phone}@s.whatsapp.net`;

    switch (mensaje.type) {
      case 'texto': {
        const text = replacePlaceholders(mensaje.contenido, lead).trim();
        if (text) await sock.sendMessage(jid, { text });
        break;
      }
      case 'formulario': {
        const rawTemplate = mensaje.contenido || '';
        const phoneVal = lead.telefono.startsWith('521')
          ? lead.telefono
          : `521${lead.telefono}`;
        const nameVal = encodeURIComponent(lead.nombre || '');
        let text = rawTemplate
          .replace('{{telefono}}', phoneVal)
          .replace('{{nombre}}', nameVal)
          .replace(/\r?\n/g, ' ')
          .trim();
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
        console.warn(`Tipo desconocido: ${mensaje.type}`);
    }
  } catch (err) {
    console.error("Error al enviar mensaje:", err);
  }
}

/**
 * Procesa las secuencias activas de cada lead.
 */
async function processSequences() {
  try {
    const leadsSnap = await db
      .collection('leads')
      .where('secuenciasActivas', '!=', null)
      .get();

    for (const doc of leadsSnap.docs) {
      const lead = { id: doc.id, ...doc.data() };
      if (!Array.isArray(lead.secuenciasActivas) || !lead.secuenciasActivas.length) continue;

      let dirty = false;

      for (const seq of lead.secuenciasActivas) {
        const { trigger, startTime, index } = seq;
        const seqSnap = await db
          .collection('secuencias')
          .where('trigger', '==', trigger)
          .get();
        if (seqSnap.empty) continue;

        const msgs = seqSnap.docs[0].data().messages;
        if (index >= msgs.length) {
          seq.completed = true;
          dirty = true;
          continue;
        }

        const msg = msgs[index];
        const sendAt = new Date(startTime).getTime() + msg.delay * 60000;
        if (Date.now() < sendAt) continue;

        await enviarMensaje(lead, msg);
        await db
          .collection('leads')
          .doc(lead.id)
          .collection('messages')
          .add({
            content: `Se envió el ${msg.type} de la secuencia ${trigger}`,
            sender: 'system',
            timestamp: new Date()
          });

        seq.index++;
        dirty = true;
      }

      if (dirty) {
        const rem = lead.secuenciasActivas.filter(s => !s.completed);
        await db.collection('leads').doc(lead.id).update({ secuenciasActivas: rem });
      }
    }
  } catch (err) {
    console.error("Error en processSequences:", err);
  }
}

/**
 * Genera letras para los registros en 'letras' con status 'Sin letra'
 * usando OpenAI, guarda la letra y marca status → 'enviarLetra'.
 */
async function generateLetras() {
  try {
    const snap = await db.collection('letras').where('status', '==', 'Sin letra').get();
    for (const doc of snap.docs) {
      const data = doc.data();
      const prompt = [
        "Eres un compositor experto. Genera la letra de una canción con estos datos:",
        ...Object.entries(data)
          .filter(([k]) => k !== 'status')
          .map(([k, v]) => `${k}: ${v}`)
      ].join('\n');

      const response = await openai.createChatCompletion({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'Eres un compositor creativo.' },
          { role: 'user', content: prompt }
        ]
      });

      const letra = response.data.choices?.[0]?.message?.content?.trim();
      if (letra) {
        await doc.ref.update({
          letra,
          status: 'enviarLetra'
        });
        console.log(`Letra generada para ${doc.id}`);
      }
    }
  } catch (err) {
    console.error("Error en generateLetras:", err);
  }
}

/**
 * Envía por WhatsApp las letras generadas (status 'enviarLetra'),
 * etiqueta al lead y marca status → 'enviada'.
 */
async function sendLetras() {
  try {
    const snap = await db.collection('letras').where('status', '==', 'enviarLetra').get();
    for (const doc of snap.docs) {
      const { leadPhone, leadId, letra } = doc.data();
      if (!leadPhone || !letra) continue;

      const sock = getWhatsAppSock();
      if (!sock) continue;

      let phone = leadPhone;
      if (!phone.startsWith('521')) phone = `521${phone}`;
      const jid = `${phone}@s.whatsapp.net`;

      await sock.sendMessage(jid, { text: letra });
      console.log(`Letra enviada a ${leadPhone}`);

      if (leadId) {
        await db.collection('leads').doc(leadId).update({
          etiquetas: FieldValue.arrayUnion('LetraEnviada')
        });
      }

      await doc.ref.update({ status: 'enviada' });
    }
  } catch (err) {
    console.error("Error en sendLetras:", err);
  }
}

export {
  processSequences,
  generateLetras,
  sendLetras
};
