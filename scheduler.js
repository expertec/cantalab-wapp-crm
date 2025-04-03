const cron = require('node-cron');
const { db } = require('./firebaseAdmin');
const { getWhatsAppSock } = require('./whatsappService');

// Función para reemplazar placeholders en el mensaje
function replacePlaceholders(template, leadData) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, fieldName) => {
    return leadData[fieldName] || match;
  });
}

// Función para enviar mensaje según el tipo
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

    // Reemplazar placeholders en el contenido
    const contenidoFinal = replacePlaceholders(mensaje.contenido, lead);

    // Dependiendo del tipo de mensaje, se construye la llamada
    if (mensaje.type === "texto") {
      await sock.sendMessage(jid, { text: contenidoFinal });
    }
    // Aquí puedes agregar condiciones para imagen, audio, archivo, etc.
    console.log(`Mensaje de tipo "${mensaje.type}" enviado a ${lead.telefono}`);
  } catch (error) {
    console.error("Error al enviar mensaje:", error);
  }
}

// Función principal que procesa las secuencias activas para cada lead
async function processSequences() {
  console.log("Ejecutando scheduler de secuencias...");
  try {
    // Obtener leads que tengan el campo "secuenciasActivas" no vacío.
    // Esto asume que cada lead tiene un array "secuenciasActivas"
    const leadsSnapshot = await db.collection('leads').where('secuenciasActivas', '!=', null).get();
    leadsSnapshot.forEach(async (doc) => {
      const lead = { id: doc.id, ...doc.data() };
      if (!lead.secuenciasActivas || lead.secuenciasActivas.length === 0) return;

      let actualizaciones = false; // Para saber si se debe actualizar el documento
      // Recorrer cada secuencia activa
      for (let i = 0; i < lead.secuenciasActivas.length; i++) {
        const seqActiva = lead.secuenciasActivas[i];
        // Obtener la secuencia desde la colección "secuencias" por trigger
        const secSnapshot = await db.collection('secuencias')
          .where('trigger', '==', seqActiva.trigger).get();
        if (secSnapshot.empty) continue;

        // Suponiendo que solo hay una secuencia para ese trigger
        const secuencia = secSnapshot.docs[0].data();
        const mensajes = secuencia.messages;

        // Si ya se han enviado todos los mensajes, se puede remover la secuencia activa
        if (seqActiva.index >= mensajes.length) {
          // Marcar para remover, aquí lo dejamos en null (posteriormente podrías filtrar)
          lead.secuenciasActivas[i] = null;
          actualizaciones = true;
          continue;
        }

        // Obtener el mensaje a enviar
        const mensaje = mensajes[seqActiva.index];
        const startTime = new Date(seqActiva.startTime);
        const envioProgramado = new Date(startTime.getTime() + mensaje.delay * 60000);

        // Si la hora actual supera el tiempo programado, enviar el mensaje
        if (Date.now() >= envioProgramado.getTime()) {
          await enviarMensaje(lead, mensaje);
          // Incrementar el índice para esta secuencia
          seqActiva.index += 1;
          actualizaciones = true;
        }
      }

      // Filtrar las secuencias activas que ya se completaron
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

// Programar la función para que se ejecute cada minuto
cron.schedule('* * * * *', () => {
  processSequences();
});