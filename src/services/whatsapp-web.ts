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
import { supabase } from './supabase';

const logger = pino({ level: 'silent' });

// Mapas en memoria para las sesiones activas y códigos QR
const activeSockets = new Map<string, WASocket>();
const activeQrs = new Map<string, string>();
const connectionStatus = new Map<string, 'connecting' | 'connected' | 'disconnected' | 'qr'>();

/**
 * Formatea un número al JID requerido por WhatsApp: "34600000000@s.whatsapp.net"
 */
function formatJid(phone: string): string {
  let clean = phone.trim().replace(/\s+/g, '').replace(/[-()+]/g, '');
  if (clean.startsWith('whatsapp:')) {
    clean = clean.substring(9);
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
  // Si ya existe y está conectada, retornarla directamente
  if (activeSockets.has(tenantId)) {
    const status = connectionStatus.get(tenantId);
    if (status === 'connected') {
      return activeSockets.get(tenantId)!;
    }
  }

  console.log(`[WhatsApp Web] Iniciando sesión para el tenant: ${tenantId}...`);
  connectionStatus.set(tenantId, 'connecting');

  const { state, saveCreds } = await useSupabaseAuthState(tenantId);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false
  });

  activeSockets.set(tenantId, sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[WhatsApp Web] Nuevo código QR generado para tenant: ${tenantId}`);
      activeQrs.set(tenantId, qr);
      connectionStatus.set(tenantId, 'qr');
    }

    if (connection === 'open') {
      console.log(`[WhatsApp Web] ¡Sesión CONECTADA con éxito para tenant: ${tenantId}!`);
      activeQrs.delete(tenantId);
      connectionStatus.set(tenantId, 'connected');
      
      // Guardar estado en base de datos
      await supabase
        .from('tenants')
        .update({ client_whatsapp_connected: true })
        .eq('id', tenantId);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`[WhatsApp Web] Conexión cerrada para tenant: ${tenantId}. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);
      
      activeSockets.delete(tenantId);
      activeQrs.delete(tenantId);
      connectionStatus.set(tenantId, 'disconnected');

      if (!shouldReconnect) {
        // El usuario cerró sesión voluntariamente o el token fue revocado
        console.log(`[WhatsApp Web] Sesión CERRADA/DESVINCULADA por completo para tenant: ${tenantId}`);
        
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
        // Intentar reconectar automáticamente después de 5 segundos
        console.log(`[WhatsApp Web] Intentando reconexión automática en 5s para tenant: ${tenantId}...`);
        setTimeout(() => initWhatsAppWebSession(tenantId), 5000);
      }
    }
  });

  return sock;
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
  try {
    const sock = activeSockets.get(tenantId);
    if (!sock || connectionStatus.get(tenantId) !== 'connected') {
      console.warn(`⚠️ No se pudo enviar mensaje por WhatsApp Web: Sesión no conectada para tenant: ${tenantId}`);
      return false;
    }

    const jid = formatJid(toPhone);
    console.log(`[WhatsApp Web Service] Enviando mensaje a ${jid} vía Baileys...`);
    
    await sock.sendMessage(jid, { text });
    return true;
  } catch (err: any) {
    console.error(`❌ Error al enviar mensaje vía WhatsApp Web para tenant ${tenantId}:`, err.message);
    return false;
  }
}

/**
 * Arranca automáticamente en segundo plano todas las sesiones de clientes que estaban conectadas
 */
export async function autoStartActiveSessions(): Promise<void> {
  try {
    console.log('[WhatsApp Web Boot] Buscando sesiones de WhatsApp que arrancar...');
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('id, client_whatsapp_provider, client_whatsapp_connected')
      .eq('client_whatsapp_provider', 'qr')
      .eq('client_whatsapp_connected', true);

    if (error) throw error;

    if (tenants && tenants.length > 0) {
      console.log(`[WhatsApp Web Boot] Iniciando ${tenants.length} sesiones activas en segundo plano...`);
      for (const t of tenants) {
        initWhatsAppWebSession(t.id).catch(err => {
          console.error(`Error al arrancar sesión de WhatsApp para tenant ${t.id}:`, err.message);
        });
      }
    } else {
      console.log('[WhatsApp Web Boot] No se encontraron sesiones previamente conectadas.');
    }
  } catch (err: any) {
    console.error('[WhatsApp Web Boot] Error al arrancar sesiones:', err.message);
  }
}
