import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';
import { db } from './firebaseAdmin.js';
import { sendMessage } from './handlers/mensajeSender.js'; // Importamos el handler de envío de mensaje
import { receiveMessage } from './handlers/mensajeReceiver.js'; // Importamos el handler de recepción de mensaje

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
      console.log("Nuevo mensaje recibido:", m);

      for (const msg of m.messages) {
        if (msg.key && !msg.key.fromMe) {
          await receiveMessage(msg);  // Llamamos al handler de recepción de mensajes
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
