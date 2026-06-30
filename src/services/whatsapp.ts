import axios from 'axios';
import { getSettingVal, supabase } from './supabase';
import { sendWhatsAppWebMessage } from './whatsapp-web';

/**
 * Formatea un número de teléfono al formato requerido por la API de WhatsApp de Twilio: "whatsapp:+34600000000"
 */
function formatWhatsAppNumber(phone: string): string {
  let clean = phone.trim().replace(/\s+/g, '').replace(/[-()]/g, '');
  
  if (clean.startsWith('whatsapp:')) {
    return clean;
  }
  
  if (!clean.startsWith('+')) {
    // Si tiene 9 dígitos y empieza con 6, 7 o 9 (España), le agregamos +34
    if (clean.length === 9 && (clean.startsWith('6') || clean.startsWith('7') || clean.startsWith('9'))) {
      clean = `+34${clean}`;
    } else if (clean.startsWith('34') && clean.length === 11) {
      clean = `+${clean}`;
    } else {
      // Fallback: si no empieza con + ni tiene prefijo, le agregamos +34
      clean = `+34${clean}`;
    }
  }
  
  return `whatsapp:${clean}`;
}

/**
 * Formatea un número de teléfono al formato requerido por la API oficial de WhatsApp Cloud: sin "+" ni espacios (ej: "34600000000")
 */
function formatCloudWhatsAppNumber(phone: string): string {
  let clean = phone.trim().replace(/\s+/g, '').replace(/[-()+]/g, '');
  if (clean.startsWith('whatsapp:')) {
    clean = clean.substring(9);
  }
  // Normalizar prefijo de país para España si el número tiene 9 dígitos
  if (clean.length === 9 && (clean.startsWith('6') || clean.startsWith('7') || clean.startsWith('9'))) {
    clean = `34${clean}`;
  }
  return clean;
}

/**
 * Envía un mensaje de WhatsApp utilizando el proveedor correspondiente (QR Web, Twilio o Cloud API).
 */
export async function sendWhatsAppMessage(toPhone: string, messageText: string, tenantId?: string): Promise<boolean> {
  try {
    let provider = 'twilio';
    let accountSid = '';
    let authToken = '';
    let fromNumber = '';
    let cloudToken = '';
    let cloudPhoneNumberId = '';

    if (tenantId) {
      // Intentar obtener la configuración específica de WhatsApp para este inquilino
      const { data: tenant, error } = await supabase
        .from('tenants')
        .select('client_whatsapp_provider, twilio_account_sid, twilio_auth_token, twilio_whatsapp_number, client_whatsapp_connected, whatsapp_cloud_token, whatsapp_cloud_phone_number_id')
        .eq('id', tenantId)
        .maybeSingle();

      if (!error && tenant) {
        provider = tenant.client_whatsapp_provider || 'qr';
        
        if (provider === 'qr') {
          console.log(`[WhatsApp Service] Tenant ${tenantId} prefiere WhatsApp Web (QR).`);
          const success = await sendWhatsAppWebMessage(tenantId, toPhone, messageText);
          if (success) {
            return true;
          }
          console.warn(`⚠️ Error o sesión desconectada en WhatsApp Web (QR) para tenant ${tenantId}.`);
          return false;
        } else if (provider === 'cloud') {
          cloudToken = tenant.whatsapp_cloud_token || '';
          cloudPhoneNumberId = tenant.whatsapp_cloud_phone_number_id || '';
          console.log(`[WhatsApp Service] Tenant ${tenantId} prefiere WhatsApp Cloud API.`);
        } else if (provider === 'twilio') {
          accountSid = tenant.twilio_account_sid || '';
          authToken = tenant.twilio_auth_token || '';
          fromNumber = tenant.twilio_whatsapp_number || '';
          
          if (accountSid && authToken && fromNumber) {
            console.log(`[WhatsApp Service] Enviando usando credenciales de Twilio del tenant: ${tenantId}`);
          } else {
            console.log(`[WhatsApp Service] El tenant ${tenantId} seleccionó Twilio pero faltan credenciales. Intentando fallback global.`);
            accountSid = '';
            authToken = '';
            fromNumber = '';
          }
        }
      } else {
        if (error) {
          console.warn(`[WhatsApp Service] Error al cargar configuración del tenant ${tenantId}:`, error.message);
        }
      }
    }

    // --- PROCESAR ENVÍO POR WHATSAPP CLOUD API ---
    if (provider === 'cloud') {
      if (!cloudToken || !cloudPhoneNumberId) {
        cloudToken = await getSettingVal('WHATSAPP_CLOUD_TOKEN') || '';
        cloudPhoneNumberId = await getSettingVal('WHATSAPP_CLOUD_PHONE_NUMBER_ID') || '';
      }

      if (!cloudToken || !cloudPhoneNumberId) {
        console.warn('⚠️ No se pudo enviar el WhatsApp: Faltan credenciales de WhatsApp Cloud API globales y específicas del tenant.');
        return false;
      }

      const toCloud = formatCloudWhatsAppNumber(toPhone);
      console.log(`[WhatsApp Service] Enviando mensaje de WhatsApp Cloud API a ${toCloud}...`);

      const response = await axios.post(
        `https://graph.facebook.com/v18.0/${cloudPhoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toCloud,
          type: 'text',
          text: {
            preview_url: false,
            body: messageText
          }
        },
        {
          headers: {
            Authorization: `Bearer ${cloudToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ WhatsApp Cloud API enviado con éxito. Message ID: ${response?.data?.messages?.[0]?.id}`);
      return true;
    }

    // --- PROCESAR ENVÍO POR TWILIO ---
    // Fallback a los ajustes globales de Twilio si no se especificaron credenciales del tenant
    if (!accountSid || !authToken || !fromNumber) {
      accountSid = await getSettingVal('TWILIO_ACCOUNT_SID') || '';
      authToken = await getSettingVal('TWILIO_AUTH_TOKEN') || '';
      fromNumber = await getSettingVal('TWILIO_WHATSAPP_NUMBER') || '';

      if (!accountSid || !authToken || !fromNumber) {
        console.warn('⚠️ No se pudo enviar el WhatsApp: Faltan credenciales de Twilio globales y específicas del tenant.');
        return false;
      }
      console.log(`[WhatsApp Service] Usando credenciales globales de Twilio.`);
    }

    const to = formatWhatsAppNumber(toPhone);
    const from = formatWhatsAppNumber(fromNumber);

    console.log(`[WhatsApp Service] Enviando mensaje de WhatsApp de Twilio de ${from} a ${to}...`);

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    
    // Crear el cuerpo en formato x-www-form-urlencoded
    const params = new URLSearchParams();
    params.append('To', to);
    params.append('From', from);
    params.append('Body', messageText);

    // Codificación Basic Auth
    const authHeader = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const response = await axios.post(url, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${authHeader}`
      }
    });

    console.log(`✅ WhatsApp enviado con éxito. Twilio Message SID: ${response.data.sid}`);
    return true;
  } catch (error: any) {
    console.error('❌ Error al enviar mensaje de WhatsApp:', error.response?.data || error.message);
    return false;
  }
}

