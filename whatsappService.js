// server/whatsappService.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';
import { db } from './firebaseAdmin.js';

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
    const { state, saveCreds } = await useMultiFileAuthState(localAuthFolder);
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
            const files = fs.readdirSync(localAuthFolder);
            for (const file of files) {
              fs.rmSync(path.join(localAuthFolder, file), { recursive: true, force: true });
            }
            console.log("Estado de autenticación limpiado.");
          } catch (error) {
            console.error("Error limpiando el estado:", error);
          }
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

    // Procesar mensajes entrantes y registrar leads
    sock.ev.on('messages.upsert', async (m) => {
      console.log("Nuevo mensaje recibido:", JSON.stringify(m, null, 2));
      const triggerSecuencia = "NuevoLead"; // Valor para activar la secuencia
      for (const msg of m.messages) {
        if (msg.key && !msg.key.fromMe) {
          const jid = msg.key.remoteJid;
          if (jid.endsWith('@g.us')) {
            console.log("Mensaje de grupo recibido, se ignora.");
            continue;
          }
          try {
            const leadRef = db.collection('leads').doc(jid);
            const doc = await leadRef.get();
            if (!doc.exists) {
              const telefono = jid.split('@')[0];
              const nombre = msg.pushName || "Sin nombre";
              const nuevoLead = {
                nombre,
                telefono,
                fecha_creacion: new Date(),
                estado: "nuevo",
                etiquetas: [triggerSecuencia],
                secuenciasActivas: [{
                  trigger: triggerSecuencia,
                  index: 0,
                  startTime: new Date()
                }],
                source: "WhatsApp"
              };
              await leadRef.set(nuevoLead);
              console.log("Nuevo lead guardado:", nuevoLead);
            } else {
              console.log("Lead ya existente:", jid);
              const leadData = doc.data();
              const secuencias = leadData.secuenciasActivas || [];
              if (!secuencias.some(seq => seq.trigger === triggerSecuencia)) {
                secuencias.push({
                  trigger: triggerSecuencia,
                  index: 0,
                  startTime: new Date()
                });
                const etiquetas = leadData.etiquetas || [];
                if (!etiquetas.includes(triggerSecuencia)) etiquetas.push(triggerSecuencia);
                await leadRef.update({ secuenciasActivas: secuencias, etiquetas });
                console.log("Secuencia activada para lead existente:", jid);
              }
            }
          } catch (error) {
            console.error("Error registrando lead:", error);
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

export function getLatestQR() {
  return latestQR;
}

export function getConnectionStatus() {
  return connectionStatus;
}

export function getWhatsAppSock() {
  return whatsappSock;
}
