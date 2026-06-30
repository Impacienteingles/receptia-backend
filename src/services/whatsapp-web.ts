import makeWASocket, { 
  AuthenticationCreds, 
  AuthenticationState, 
  BufferJSON, 
  DisconnectReason, 
  initAuthCreds, 
  proto, 
  WASocket 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { supabase, getSettingVal } from './supabase';
import { processChatbotMessage } from './chatbot';

const logger = pino({ level: 'silent' });

// Mapas en memoria para las sesiones activas y códigos QR
const activeSockets = new Map<string, WASocket>();
const activeQrs = new Map<string, string>();
const connectionStatus = new Map<string, 'connecting' | 'connected' | 'disconnected' | 'qr'>();
const connectionRetries = new Map<string, number>();

export const debugLogs: string[] = [];
export function logDebug(msg: string) {
  const line = `[${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}] ${msg}`;
  console.log(line);
  debugLogs.push(line);
  if (debugLogs.length > 200) debugLogs.shift();
}

/**
 * Formatea un número al JID requerido por WhatsApp: "34600000000@s.whatsapp.net"
 */
function formatJid(phone: string): string {
  let clean = phone.trim().replace(/\s+/g, '').replace(/[-()+]/g, '');
  if (clean.startsWith('whatsapp:')) {
    clean = clean.substring(9);
  }
  // Normalizar prefijo de país para España si el número tiene 9 dígitos
  if (clean.length === 9 && (clean.startsWith('6') || clean.startsWith('7') || clean.startsWith('9'))) {
    clean = `34${clean}`;
  }
  if (!clean.endsWith('@s.whatsapp.net')) {
    clean = `${clean}@s.whatsapp.net`;
  }
  return clean;
}

/**
 * Proveedor de autenticación persistente basado en Supabase para Baileys
 */
async function useSupabaseAuthState(tenantId: string): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }> {
  let creds: AuthenticationCreds;

  // 1. Cargar o inicializar creds
  const { data: dbCreds } = await supabase
    .from('whatsapp_auth_states')
    .select('data')
    .eq('tenant_id', tenantId)
    .eq('key_type', 'creds')
    .eq('key_id', 'creds')
    .maybeSingle();

  if (dbCreds && dbCreds.data) {
    creds = JSON.parse(JSON.stringify(dbCreds.data), BufferJSON.reviver);
  } else {
    creds = initAuthCreds();
  }

  // 2. Guardar creds
  const saveCreds = async () => {
    const serializedCreds = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
    await supabase
      .from('whatsapp_auth_states')
      .upsert({
        tenant_id: tenantId,
        key_type: 'creds',
        key_id: 'creds',
        data: serializedCreds
      }, {
        onConflict: 'tenant_id,key_type,key_id'
      });
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const data: { [key: string]: any } = {};
          if (ids.length === 0) return data;

          const { data: dbKeys } = await supabase
            .from('whatsapp_auth_states')
            .select('key_id, data')
            .eq('tenant_id', tenantId)
            .eq('key_type', type)
            .in('key_id', ids);

          if (dbKeys) {
            for (const item of dbKeys) {
              let value = JSON.parse(JSON.stringify(item.data), BufferJSON.reviver);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[item.key_id] = value;
            }
          }
          return data;
        },
        set: async (data: any) => {
          const upserts = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const val = data[type][id];
              const serializedVal = JSON.parse(JSON.stringify(val, BufferJSON.replacer));
              
              if (val === null) {
                await supabase
                  .from('whatsapp_auth_states')
                  .delete()
                  .eq('tenant_id', tenantId)
                  .eq('key_type', type)
                  .eq('key_id', id);
              } else {
                upserts.push({
                  tenant_id: tenantId,
                  key_type: type,
                  key_id: id,
                  data: serializedVal
                });
              }
            }
          }

          if (upserts.length > 0) {
            await supabase
              .from('whatsapp_auth_states')
              .upsert(upserts, {
                onConflict: 'tenant_id,key_type,key_id'
              });
          }
        }
      }
    },
    saveCreds
  };
}

/**
 * Inicializa y conecta una sesión de WhatsApp Web por cliente (tenant)
 */
export async function initWhatsAppWebSession(tenantId: string): Promise<WASocket> {
  // Si ya existe y está en memoria:
  if (activeSockets.has(tenantId)) {
    const status = connectionStatus.get(tenantId);
    if (status === 'connected') {
      return activeSockets.get(tenantId)!;
    }
    
    // Si está conectando o en QR y se re-inicializa, cerramos el socket anterior para evitar fugas
    try {
      const oldSock = activeSockets.get(tenantId);
      if (oldSock) {
        logDebug(`[WhatsApp Web] Cerrando socket previo incompleto (estado: ${status}) para tenant ${tenantId}...`);
        oldSock.ev.removeAllListeners('connection.update');
        oldSock.ev.removeAllListeners('creds.update');
        oldSock.end(undefined);
      }
    } catch (err: any) {
      logDebug(`[WhatsApp Web WARNING] Error al cerrar socket previo para tenant ${tenantId}: ${err.message}`);
    }
    activeSockets.delete(tenantId);
  }

  logDebug(`[WhatsApp Web] Iniciando sesión para el tenant: ${tenantId}...`);
  connectionStatus.set(tenantId, 'connecting');

  try {
    const { state, saveCreds } = await useSupabaseAuthState(tenantId);

    const sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false
    });

    activeSockets.set(tenantId, sock);

    sock.ev.on('creds.update', () => {
      logDebug(`[creds.update] Guardando credenciales para tenant ${tenantId}...`);
      saveCreds().catch(e => logDebug(`[creds.update ERROR] No se guardaron las credenciales: ${e.message}`));
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logDebug(`[WhatsApp Web] Nuevo código QR generado para tenant: ${tenantId}`);
        activeQrs.set(tenantId, qr);
        connectionStatus.set(tenantId, 'qr');
      }

      if (connection === 'open') {
        logDebug(`[WhatsApp Web] ¡Sesión CONECTADA con éxito para tenant: ${tenantId}!`);
        activeQrs.delete(tenantId);
        connectionStatus.set(tenantId, 'connected');
        connectionRetries.set(tenantId, 0); // Restablecer contador al conectar con éxito
        
        // Guardar estado en base de datos
        await supabase
          .from('tenants')
          .update({ client_whatsapp_connected: true })
          .eq('id', tenantId);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        logDebug(`[WhatsApp Web] Conexión cerrada para tenant: ${tenantId}. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);
        
        activeSockets.delete(tenantId);
        activeQrs.delete(tenantId);
        connectionStatus.set(tenantId, 'disconnected');

        if (!shouldReconnect) {
          logDebug(`[WhatsApp Web] Sesión CERRADA/DESVINCULADA por completo para tenant: ${tenantId}`);
          connectionRetries.set(tenantId, 0); // Restablecer contador
          
          // Limpiar base de datos
          await supabase
            .from('whatsapp_auth_states')
            .delete()
            .eq('tenant_id', tenantId);

          await supabase
            .from('tenants')
            .update({ client_whatsapp_connected: false })
            .eq('id', tenantId);
        } else {
          const retries = connectionRetries.get(tenantId) || 0;
          if (retries >= 5) {
            logDebug(`[WhatsApp Web] ⚠️ Límite de reconexiones alcanzado (5) para tenant: ${tenantId}. Deteniendo intentos automáticos para evitar fugas de memoria.`);
            connectionRetries.set(tenantId, 0); // Restablecer contador
            
            await supabase
              .from('tenants')
              .update({ client_whatsapp_connected: false })
              .eq('id', tenantId);
          } else {
            connectionRetries.set(tenantId, retries + 1);
            logDebug(`[WhatsApp Web] Intentando reconexión automática (${retries + 1}/5) en 5s para tenant: ${tenantId}...`);
            setTimeout(() => initWhatsAppWebSession(tenantId), 5000);
          }
        }
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;
      
      for (const msg of m.messages) {
        if (msg.key.fromMe) continue;
        
        const senderJid = msg.key.remoteJid || '';
        if (senderJid.endsWith('@g.us') || senderJid.endsWith('@broadcast')) continue;
        
        const messageText = msg.message?.conversation || 
                            msg.message?.extendedTextMessage?.text || 
                            '';
                            
        if (!messageText || messageText.trim() === '') continue;
        
        const cleanPhone = senderJid.split('@')[0];
        logDebug(`[WhatsApp Chatbot] Mensaje entrante de ${cleanPhone} (Tenant: ${tenantId}): "${messageText}"`);
        
        try {
          const { data: tenant, error: tErr } = await supabase
            .from('tenants')
            .select('id, chatbot_enabled, phone_number, business_name')
            .eq('id', tenantId)
            .single();
            
          if (tErr || !tenant) {
            logDebug(`[WhatsApp Chatbot] Tenant ${tenantId} no encontrado.`);
            continue;
          }
          
          if (!tenant.chatbot_enabled) {
            logDebug(`[WhatsApp Chatbot] Chatbot desactivado para ${tenant.business_name}. Omitiendo.`);
            continue;
          }
          
          const webhookBaseUrl = await getSettingVal('WEBHOOK_BASE_URL') || 'https://corandar.onrender.com';
          const aiReply = await processChatbotMessage(tenantId, cleanPhone, messageText.trim(), webhookBaseUrl);
          
          await sendWhatsAppWebMessage(tenantId, cleanPhone, aiReply);
          logDebug(`[WhatsApp Chatbot] Respuesta de la IA enviada a ${cleanPhone} con éxito.`);
          
        } catch (err: any) {
          logDebug(`[WhatsApp Chatbot ERROR] Error al procesar mensaje de ${cleanPhone}: ${err.message}`);
        }
      }
    });

    return sock;
  } catch (err: any) {
    logDebug(`[WhatsApp Web ERROR] Error al inicializar sesión para tenant ${tenantId}: ${err.stack || err.message}`);
    connectionStatus.set(tenantId, 'disconnected');
    throw err;
  }
}

/**
 * Desconecta y cierra sesión limpiando credenciales en base de datos
 */
export async function disconnectWhatsAppWebSession(tenantId: string): Promise<void> {
  const sock = activeSockets.get(tenantId);
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      await sock.logout().catch(() => {});
      sock.end(undefined);
    } catch (e) {}
  }
  
  // Limpieza manual por seguridad
  activeSockets.delete(tenantId);
  activeQrs.delete(tenantId);
  connectionStatus.set(tenantId, 'disconnected');

  await supabase
    .from('whatsapp_auth_states')
    .delete()
    .eq('tenant_id', tenantId);

  await supabase
    .from('tenants')
    .update({ client_whatsapp_connected: false })
    .eq('id', tenantId);
  
  console.log(`[WhatsApp Web] Sesión desconectada y limpiada para tenant: ${tenantId}`);
}

/**
 * Obtiene el estado actual de la sesión del cliente
 */
export function getWhatsAppSessionStatus(tenantId: string): { status: 'connected' | 'disconnected' | 'connecting' | 'qr', qrText?: string } {
  const status = connectionStatus.get(tenantId) || 'disconnected';
  const qrText = activeQrs.get(tenantId);
  return { status, qrText };
}

/**
 * Envía un mensaje a través de la sesión de WhatsApp Web del cliente
 */
export async function sendWhatsAppWebMessage(tenantId: string, toPhone: string, text: string): Promise<boolean> {
  const sock = activeSockets.get(tenantId);
  const status = connectionStatus.get(tenantId) || 'disconnected';
  
  logDebug(`[sendWhatsAppWebMessage] Intento de envío a ${toPhone} (Tenant: ${tenantId}). Estado en memoria: ${status}, Socket en memoria: ${!!sock}`);
  
  try {
    if (!sock || status !== 'connected') {
      logDebug(`⚠️ [sendWhatsAppWebMessage] No se pudo enviar: Sesión no conectada para tenant: ${tenantId} (Status: ${status})`);
      return false;
    }

    const jid = formatJid(toPhone);
    logDebug(`[sendWhatsAppWebMessage] Enviando mensaje a JID ${jid} vía Baileys...`);
    
    await sock.sendMessage(jid, { text });
    logDebug(`[sendWhatsAppWebMessage] ✅ Mensaje enviado exitosamente a ${jid}`);
    return true;
  } catch (err: any) {
    logDebug(`❌ [sendWhatsAppWebMessage ERROR] Fallo al enviar mensaje a ${toPhone} vía Baileys: ${err.stack || err.message}`);
    return false;
  }
}

/**
 * Arranca automáticamente en segundo plano todas las sesiones de clientes que estaban conectadas
 */
export async function autoStartActiveSessions(): Promise<void> {
  try {
    logDebug('[WhatsApp Web Boot] Buscando sesiones de WhatsApp que arrancar...');
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('id, client_whatsapp_provider, client_whatsapp_connected')
      .eq('client_whatsapp_provider', 'qr')
      .eq('client_whatsapp_connected', true);

    if (error) throw error;

    if (tenants && tenants.length > 0) {
      logDebug(`[WhatsApp Web Boot] Iniciando ${tenants.length} sesiones activas en segundo plano...`);
      for (const t of tenants) {
        initWhatsAppWebSession(t.id).catch(err => {
          logDebug(`Error al arrancar sesión de WhatsApp para tenant ${t.id}: ${err.message}`);
        });
      }
    } else {
      logDebug('[WhatsApp Web Boot] No se encontraron sesiones previamente conectadas.');
    }
  } catch (err: any) {
    logDebug(`[WhatsApp Web Boot ERROR] Error al arrancar sesiones: ${err.message}`);
  }
}
