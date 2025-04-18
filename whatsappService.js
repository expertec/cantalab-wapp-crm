import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';
import { db } from './firebaseAdmin.js';  // Usamos firebase-admin

let latestQR = null;
let connectionStatus = "Desconectado";
let whatsappSock = null;
const localAuthFolder = '/var/data';

export async function connectToWhatsApp() {
  try {
    console.log("Verificando carpeta de autenticación en:", localAuthFolder);
    if (!fs.existsSync(localAuthFolder)) {
      fs.mkdirSync(localAuthFolder, { recursive: true });
      console.log("Carpeta creada:", localAuthFolder);
    } else {
      console.log("Carpeta de autenticación existente:", localAuthFolder);
    }
    console.log("Obteniendo estado de autenticación...");
    const { state, saveCreds } = await useMultiFileAuthState(localAuthFolder);
    console.log("Obteniendo la última versión de Baileys...");
    const { version } = await fetchLatestBaileysVersion();
    console.log("Versión obtenida:", version);
    console.log("Intentando conectar con WhatsApp...");
    const sock = makeWASocket({
      auth: state,
      logger: Pino({ level: 'info' }),
      printQRInTerminal: true,
      version,
    });
    whatsappSock = sock;

    sock.ev.on('connection.update', (update) => {
      console.log("connection.update:", update);
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        latestQR = qr;
        connectionStatus = "QR disponible. Escanéalo.";
        QRCode.generate(qr, { small: true });
        console.log("QR generado, escanéalo.");
      }
      if (connection === 'open') {
        connectionStatus = "Conectado";
        latestQR = null;
        console.log("Conexión exitosa con WhatsApp!");
      }
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        connectionStatus = "Desconectado";
        console.log("Conexión cerrada. Razón:", reason);
        if (reason === DisconnectReason.loggedOut) {
          console.log("La sesión se cerró (loggedOut). Limpiando estado de autenticación...");
          try {
            if (fs.existsSync(localAuthFolder)) {
              const files = fs.readdirSync(localAuthFolder);
              for (const file of files) {
                fs.rmSync(path.join(localAuthFolder, file), { recursive: true, force: true });
              }
              console.log("Estado de autenticación limpiado.");
            }
          } catch (error) {
            console.error("Error limpiando el estado:", error);
          }
          console.log("Conectando a una nueva cuenta de WhatsApp...");
          connectToWhatsApp();
        } else {
          console.log("Reconectando...");
          connectToWhatsApp();
        }
      }
    });

    sock.ev.on('creds.update', (creds) => {
      console.log("Credenciales actualizadas:", creds);
      saveCreds();
    });

    sock.ev.on('messages.upsert', async (m) => {
      console.log("Nuevo mensaje recibido:", JSON.stringify(m, null, 2));

      let config = { autoSaveLeads: true, defaultTrigger: "NuevoLead" };
      try {
        const configSnap = await db.collection("config").doc("appConfig").get();
        if (configSnap.exists) {
          config = { ...config, ...configSnap.data() };
        } else {
          console.log("No se encontró 'appConfig', usando valores por defecto.");
        }
      } catch (error) {
        console.error("Error al obtener configuración:", error);
      }

      if (!config.autoSaveLeads) {
        console.log("Guardado automático de leads desactivado en configuración.");
        return;
      }

      let secuenciasQuerySnapshot;
      try {
        secuenciasQuerySnapshot = await db.collection("secuencias").get();
      } catch (err) {
        console.error("Error al obtener secuencias:", err);
        return;
      }
      const availableTriggers = secuenciasQuerySnapshot.docs.map(doc => doc.data().trigger);
      const triggerDefault = config.defaultTrigger || "NuevoLead";

      for (const msg of m.messages) {
        if (msg.key && !msg.key.fromMe) {
          const jid = msg.key.remoteJid;
          if (jid.endsWith('@g.us')) {
            console.log("Mensaje de grupo recibido, se ignora.");
            continue;
          }
          try {
            let leadRef;
            const leadId = jid.split('@')[0]; // Usamos solo el teléfono como ID del lead

            // Buscamos el lead utilizando el número de teléfono sin importar el número
            const leadSnap = await db.collection('leads').where('telefono', '==', leadId).get();

            if (leadSnap.empty) {
              const nombre = msg.pushName || "Sin nombre";
              const etiquetas = [triggerDefault];
              const secuenciasAAgregar = [];

              etiquetas.forEach(tag => {
                if (availableTriggers.includes(tag)) {
                  secuenciasAAgregar.push({
                    trigger: tag,
                    startTime: new Date().toISOString(),
                    index: 0
                  });
                }
              });

              leadRef = db.collection('leads').doc();
              await leadRef.set({
                nombre,
                telefono: leadId,
                fecha_creacion: new Date(),
                estado: "nuevo",
                etiquetas,
                secuenciasActivas: secuenciasAAgregar,
                source: "WhatsApp"
              });
              console.log("Nuevo lead guardado:", leadId);
            } else {
              leadRef = leadSnap.docs[0].ref;
              console.log("Lead ya existente:", leadId);
              const leadData = leadSnap.docs[0].data();
              const secuencias = leadData.secuenciasActivas || [];
              if (!secuencias.some(seq => seq.trigger === triggerDefault)) {
                if (availableTriggers.includes(triggerDefault)) {
                  secuencias.push({
                    trigger: triggerDefault,
                    startTime: new Date().toISOString(),
                    index: 0
                  });
                  const etiquetas = leadData.etiquetas || [];
                  if (!etiquetas.includes(triggerDefault)) etiquetas.push(triggerDefault);
                  await leadRef.update({
                    secuenciasActivas: secuencias,
                    etiquetas
                  });
                  console.log("Secuencia activada para lead existente:", leadId);
                }
              }
            }

            const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            const newMessage = {
              content: messageContent,
              sender: "lead",
              timestamp: new Date(),
            };

            await leadRef.collection("messages").add(newMessage);
            console.log("Mensaje guardado en Firebase:", newMessage);

          } catch (error) {
            console.error("Error procesando el mensaje del lead:", error);
          }
        }
      }
    });

    console.log("Conexión de WhatsApp establecida, retornando socket.");
    return sock;
  } catch (error) {
    console.error("Error al conectar con WhatsApp:", error);
    throw error;
  }
}

// Nueva función para enviar mensajes
export async function sendMessageToLead(leadId, messageContent) {
  try {
    const sock = getWhatsAppSock();
    if (!sock) {
      throw new Error('No hay conexión activa con WhatsApp');
    }

    let phone = leadId;
    if (!phone.startsWith('521')) {
      phone = `521${phone}`;
    }
    const jid = `${phone}@s.whatsapp.net`;

    // Timeout para asegurar que el mensaje no quede esperando indefinidamente
    const sendMessagePromise = sock.sendMessage(jid, { text: messageContent });
    
    // Establecer un límite de tiempo de 10 segundos para la operación
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out')), 10000));
    
    // Intentar enviar el mensaje con un timeout
    await Promise.race([sendMessagePromise, timeout]);

    console.log(`Mensaje enviado a ${jid}: ${messageContent}`);
    return { success: true, message: 'Mensaje enviado a WhatsApp' };
  } catch (error) {
    console.error("Error enviando mensaje de WhatsApp:", error);
    throw new Error(`Error enviando mensaje: ${error.message}`);
  }
}

export function getLatestQR() {
  return latestQR;
}

export function getConnectionStatus() {
  return connectionStatus;
}

export function getWhatsAppSock() {
  return whatsappSock;
}
