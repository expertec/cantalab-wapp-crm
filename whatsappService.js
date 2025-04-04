// server/whatsappService.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';

let latestQR = null;
let connectionStatus = "Desconectado";
let whatsappSock = null;

// Ajusta la ruta al disco persistente en Render
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
          console.log("La sesión se cerró (loggedOut). Limpiando estado de autenticación para registrar una nueva cuenta...");
          try {
            if (fs.existsSync(localAuthFolder)) {
              const files = fs.readdirSync(localAuthFolder);
              for (const file of files) {
                const filePath = path.join(localAuthFolder, file);
                fs.rmSync(filePath, { recursive: true, force: true });
              }
              console.log("Estado de autenticación limpiado.");
            }
          } catch (error) {
            console.error("Error limpiando el estado de autenticación:", error);
          }
          console.log("Conectando a una nueva cuenta de WhatsApp...");
          connectToWhatsApp();
        } else {
          console.log("Intentando reconectar con la misma sesión de WhatsApp...");
          connectToWhatsApp();
        }
      }
    });
    sock.ev.on('creds.update', (creds) => {
      console.log("Credenciales actualizadas:", creds);
      saveCreds();
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
