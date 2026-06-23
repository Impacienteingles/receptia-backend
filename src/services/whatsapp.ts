import axios from 'axios';
import { getSettingVal } from './supabase';

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
 * Formatea un número de teléfono a formato E.164 estándar (+34600000000)
 */
function formatE164Number(phone: string): string {
  let clean = phone.trim().replace(/\s+/g, '').replace(/[-()]/g, '');
  
  if (clean.startsWith('whatsapp:')) {
    clean = clean.substring(9);
  }
  
  if (!clean.startsWith('+')) {
    if (clean.length === 9 && (clean.startsWith('6') || clean.startsWith('7') || clean.startsWith('9'))) {
      clean = `+34${clean}`;
    } else if (clean.startsWith('34') && clean.length === 11) {
      clean = `+${clean}`;
    } else {
      clean = `+34${clean}`;
    }
  }
  
  return clean;
}

/**
 * Envía un mensaje de WhatsApp utilizando el proveedor configurado (Twilio o Wassenger).
 */
export async function sendWhatsAppMessage(toPhone: string, messageText: string): Promise<boolean> {
  try {
    const provider = (await getSettingVal('WHATSAPP_PROVIDER')) || 'twilio';

    if (provider === 'wassenger') {
      const apiToken = await getSettingVal('WASSENGER_API_TOKEN');
      if (!apiToken || apiToken.trim() === '') {
        console.warn('⚠️ No se pudo enviar el WhatsApp: Falta la API Token de Wassenger (WASSENGER_API_TOKEN) en los ajustes.');
        return false;
      }

      const to = formatE164Number(toPhone);
      console.log(`[WhatsApp Service] Enviando mensaje de WhatsApp vía Wassenger a ${to}...`);

      const url = 'https://api.wassenger.com/v1/messages';
      const response = await axios.post(url, {
        phone: to,
        message: messageText
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Token': apiToken
        }
      });

      console.log(`✅ WhatsApp enviado con éxito vía Wassenger. Message ID: ${response.data.id || response.data._id}`);
      return true;
    } else {
      const accountSid = await getSettingVal('TWILIO_ACCOUNT_SID');
      const authToken = await getSettingVal('TWILIO_AUTH_TOKEN');
      let fromNumber = await getSettingVal('TWILIO_WHATSAPP_NUMBER');

      if (!accountSid || !authToken || !fromNumber) {
        console.warn('⚠️ No se pudo enviar el WhatsApp: Faltan credenciales de Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER) en los ajustes.');
        return false;
      }

      const to = formatWhatsAppNumber(toPhone);
      const from = formatWhatsAppNumber(fromNumber);

      console.log(`[WhatsApp Service] Enviando mensaje de WhatsApp de ${from} a ${to}...`);

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
    }
  } catch (error: any) {
    console.error('❌ Error al enviar mensaje de WhatsApp:', error.response?.data || error.message);
    return false;
  }
}

