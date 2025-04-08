// server/whatsappService.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';
import { db } from './firebaseAdmin.js';

// Aquí mantenemos un objeto que mapea businessId a su conexión
const connections = {};

// Función para crear o retornar una conexión para un businessId específico
export async function connectToWhatsApp(businessId) {
  const localAuthFolder = `/var/data/${businessId}`;
  
  // Si ya existe conexión para este negocio, la retornamos
  if (connections[businessId] && connections[businessId].whatsappSock) {
    console.log(`Ya existe conexión para el negocio ${businessId}`);
    return connections[businessId].whatsappSock;
  }
  
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
    
    console.log("Intentando conectar con WhatsApp para businessId:", businessId);
    const sock = makeWASocket({
      auth: state,
      logger: Pino({ level: 'info' }),
      printQRInTerminal: true,
      version,
    });
    
    // Creamos el objeto de conexión para este businessId
    connections[businessId] = {
      whatsappSock: sock,
      latestQR: null,
      connectionStatus: "Desconectado",
    };
    
    // Registrar los eventos en esta conexión
    sock.ev.on('connection.update', (update) => {
      console.log("connection.update:", update);
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        connections[businessId].latestQR = qr;
        connections[businessId].connectionStatus = "QR disponible. Escanéalo.";
        QRCode.generate(qr, { small: true });
        console.log(`QR generado para businessId ${businessId}, escanéalo.`);
      }
      if (connection === 'open') {
        connections[businessId].connectionStatus = "Conectado";
        connections[businessId].latestQR = null;
        console.log(`Conexión exitosa con WhatsApp para businessId ${businessId}`);
      }
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        connections[businessId].connectionStatus = "Desconectado";
        console.log(`Conexión cerrada para businessId ${businessId}. Razón:`, reason);
        if (reason === DisconnectReason.loggedOut) {
          console.log("La sesión se cerró (loggedOut). Limpiando estado de autenticación...");
          try {
            if (fs.existsSync(localAuthFolder)) {
              const files = fs.readdirSync(localAuthFolder);
              for (const file of files) {
                fs.rmSync(path.join(localAuthFolder, file), { recursive: true, force: true });
              }
              console.log("Estado de autenticación limpiado para businessId", businessId);
            }
          } catch (error) {
            console.error("Error limpiando el estado:", error);
          }
          console.log("Conectando a una nueva cuenta de WhatsApp para businessId:", businessId);
          connectToWhatsApp(businessId);
        } else {
          console.log("Reconectando para businessId:", businessId);
          connectToWhatsApp(businessId);
        }
      }
    });
    
    sock.ev.on('creds.update', (creds) => {
      console.log("Credenciales actualizadas para businessId", businessId, ":", creds);
      saveCreds();
    });
    
    // Registro y activación de leads se registrará en la conexión correspondiente.
    sock.ev.on('messages.upsert', async (m) => {
      console.log("Nuevo mensaje recibido:", JSON.stringify(m, null, 2));
      
      // Primero se obtiene la configuración global.
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
      
      // Obtener triggers disponibles en la colección "secuencias"
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
        // Procesar solo mensajes entrantes (no enviados por nosotros)
        if (msg.key && !msg.key.fromMe) {
          const jid = msg.key.remoteJid;
          if (jid.endsWith('@g.us')) {
            console.log("Mensaje de grupo recibido, se ignora.");
            continue;
          }
          try {
            const leadRef = db.collection('leads').doc(jid);
            const docSnap = await leadRef.get();
            if (!docSnap.exists) {
              const telefono = jid.split('@')[0];
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
              // Al crear el lead, se asocia su businessId actual.
              const nuevoLead = {
                nombre,
                telefono,
                businessId, // se guarda el id del negocio asociado
                fecha_creacion: new Date(),
                estado: "nuevo",
                etiquetas,
                secuenciasActivas: secuenciasAAgregar,
                source: "WhatsApp"
              };
              await leadRef.set(nuevoLead);
              console.log("Nuevo lead guardado:", nuevoLead);
            } else {
              console.log("Lead ya existente:", jid);
              const leadData = docSnap.data();
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
                  console.log("Secuencia activada para lead existente:", jid);
                }
              }
            }
          } catch (error) {
            console.error("Error registrando lead:", error);
          }
        }
      }
    });
    
    console.log("Conexión de WhatsApp establecida para businessId", businessId, ", retornando socket.");
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

export function getWhatsAppSock(businessId) {
  if (connections[businessId] && connections[businessId].whatsappSock) {
    return connections[businessId].whatsappSock;
  }
  return null;
}
