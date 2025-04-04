// server/whatsappService.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';

let latestQR = null;
let connectionStatus = "Desconectado";
let whatsappSock = null;

// Variable para el backoff en reconexiones por error 515
let reconnectAttempts = 0;

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
        reconnectAttempts = 0; // reiniciamos el contador al conectarse
        console.log("Conexión exitosa con WhatsApp!");
      }
      
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        connectionStatus = "Desconectado";
        console.log("Conexión cerrada. Razón:", reason);
        
        let delayTime = 10000; // Delay por defecto: 10 segundos
        
        if (reason === 408) {
          // Error QR timeout: no limpiar el estado y esperar 30 segundos
          reconnectAttempts = 0;
          delayTime = 30000;
          console.log("Error 408 (QR timeout): se espera 30 segundos sin limpiar el estado.");
        } else if (reason === 515) {
          // Error de stream: limpiar estado y aumentar el delay (exponential backoff)
          reconnectAttempts++;
          delayTime = Math.min(30000 * reconnectAttempts, 300000); // hasta 5 minutos máximo
          console.log(`Error 515 (Stream Errored): intento ${reconnectAttempts}, se borrarán los contenidos de autenticación y se esperarán ${delayTime / 1000} segundos.`);
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
          // Para otros errores, limpiar el estado y usar delay por defecto
          reconnectAttempts = 0;
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
