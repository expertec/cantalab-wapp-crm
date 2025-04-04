// server/whatsappService.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';

let latestQR = null;
let connectionStatus = "Desconectado";
let whatsappSock = null;

// Ruta al disco persistente en Render
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
        
        // Configuramos el delay según el error
        let delayTime = 10000; // Por defecto, 10 segundos
        
        if (reason === 408) {
          console.log("Error 408 (QR timeout): no se limpia el estado y se espera 30 segundos.");
          delayTime = 30000;
        } else if (reason === 515) {
          console.log("Error 515 (Stream Errored): se borrarán los contenidos de autenticación y se esperarán 30 segundos.");
          delayTime = 30000;
          try {
            if (fs.existsSync(localAuthFolder)) {
              const files = fs.readdirSync(localAuthFolder);
              for (const file of files) {
                const filePath = path.join(localAuthFolder, file);
                fs.rmSync(filePath, { recursive: true, force: true });
              }
              console.log("Se han borrado los contenidos de autenticación para una nueva sesión.");
            }
          } catch (err) {
            console.error("Error al borrar el estado de autenticación:", err);
          }
        } else {
          // Para otros errores, limpiar estado y usar delay por defecto
          try {
            if (fs.existsSync(localAuthFolder)) {
              const files = fs.readdirSync(localAuthFolder);
              for (const file of files) {
                const filePath = path.join(localAuthFolder, file);
                fs.rmSync(filePath, { recursive: true, force: true });
              }
              console.log("Se han borrado los contenidos de autenticación para una nueva sesión.");
            }
          } catch (err) {
            console.error("Error al borrar el estado de autenticación:", err);
          }
        }
        
        setTimeout(() => {
          console.log("Intentando reconectar con WhatsApp (nueva sesión)...");
          connectToWhatsApp();
        }, delayTime);
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
