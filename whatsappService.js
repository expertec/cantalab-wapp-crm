// server/whatsappService.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';
import { db } from './firebaseAdmin.js'; // Importamos Firestore

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

    // Escuchar mensajes entrantes para capturar nuevos leads y activar secuencias
    sock.ev.on('messages.upsert', async (m) => {
      console.log("Nuevo mensaje recibido:", JSON.stringify(m, null, 2));
      const triggerSecuencia = "NuevoLead"; // Valor de trigger para activar la secuencia
      for (const msg of m.messages) {
        // Procesar solo mensajes entrantes (no enviados por nosotros)
        if (msg.key && !msg.key.fromMe) {
          const jid = msg.key.remoteJid;
          // Ignorar mensajes de grupos
          if (jid.endsWith('@g.us')) {
            console.log("Mensaje de grupo recibido, se ignora.");
            continue;
          }
          try {
            const leadRef = db.collection('leads').doc(jid);
            const doc = await leadRef.get();
            if (!doc.exists) {
              // Extraer número y nombre del mensaje
              const telefono = jid.split('@')[0];
              const nombre = msg.pushName || "Sin nombre";
              // Crear el nuevo lead con los campos requeridos
              const nuevoLead = {
                nombre,
                telefono,
                fecha_creacion: new Date(),
                estado: "nuevo",
                etiquetas: [triggerSecuencia],
                secuenciasActivas: [
                  {
                    trigger: triggerSecuencia,
                    index: 0,
                    startTime: new Date()
                  }
                ],
                source: "WhatsApp"
              };
              await leadRef.set(nuevoLead);
              console.log("Nuevo lead guardado:", nuevoLead);
            } else {
              console.log("Lead ya existente:", jid);
              // Verificar si la secuencia ya está activa; si no, agregarla
              const leadData = doc.data();
              const secuencias = leadData.secuenciasActivas || [];
              const yaActivada = secuencias.some(seq => seq.trigger === triggerSecuencia);
              if (!yaActivada) {
                secuencias.push({
                  trigger: triggerSecuencia,
                  index: 0,
                  startTime: new Date()
                });
                // Agregar la etiqueta si aún no existe
                const etiquetas = leadData.etiquetas || [];
                if (!etiquetas.includes(triggerSecuencia)) {
                  etiquetas.push(triggerSecuencia);
                }
                await leadRef.update({
                  secuenciasActivas: secuencias,
                  etiquetas: etiquetas
                });
                console.log("Secuencia activada para lead existente:", jid);
              }
            }
          } catch (error) {
            console.error("Error guardando nuevo lead:", error);
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
