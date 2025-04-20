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

    const sock = makeWASocket({
      auth: state,
      logger: Pino({ level: 'info' }),
      printQRInTerminal: true,
      version,
    });

    whatsappSock = sock;

    sock.ev.on('connection.update', (update) => {
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
          // Limpiar credenciales
          if (fs.existsSync(localAuthFolder)) {
            fs.readdirSync(localAuthFolder).forEach(file => 
              fs.rmSync(path.join(localAuthFolder, file), { recursive: true, force: true })
            );
            console.log("Estado de autenticación limpiado.");
          }
          connectToWhatsApp();
        } else {
          connectToWhatsApp();
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
      console.log("Nuevo mensaje recibido:", JSON.stringify(m, null, 2));
      // Procesar solamente mensajes entrantes
      for (const msg of m.messages) {
        if (msg.key && !msg.key.fromMe) {
          const jid = msg.key.remoteJid;
          if (jid.endsWith('@g.us')) continue; // ignorar grupos

          // Guardar lead y mensaje en Firestore
          try {
            const leadRef = db.collection('leads').doc(jid);
            const docSnap = await leadRef.get();

            if (!docSnap.exists) {
              const telefono = jid.split('@')[0];
              const nombre = msg.pushName || "Sin nombre";
              await leadRef.set({ nombre, telefono, fecha_creacion: new Date(), estado: 'nuevo', source: 'WhatsApp' });
              console.log("Nuevo lead guardado:", telefono);
            }

            const content = msg.message?.conversation 
              || msg.message?.extendedTextMessage?.text 
              || '';

            await leadRef.collection('messages').add({
              content,
              sender: 'lead',
              timestamp: new Date(),
            });

            console.log("Mensaje de lead guardado en Firebase:", content);
          } catch (err) {
            console.error("Error procesando mensaje entrante:", err);
          }
        }
      }
    });

    console.log("WhatsApp socket inicializado correctamente.");
    return sock;
  } catch (error) {
    console.error("Error al conectar con WhatsApp:", error);
    throw error;
  }
}

export async function sendMessageToLead(phone, messageContent) {
  try {
    const sock = whatsappSock;
    if (!sock) throw new Error('No hay conexión activa con WhatsApp');

    let number = phone;
    if (!number.startsWith('521')) number = `521${number}`;
    const jid = `${number}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: messageContent });
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