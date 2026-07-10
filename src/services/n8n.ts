import axios from 'axios';

const CARLOS_ROMERO_TENANT_ID = '62d1ed82-287c-4329-941b-50b578c15b14';
const N8N_WEBHOOK_URL = 'https://corandar.app.n8n.cloud/webhook/90bf835d-5380-4779-b70d-745d068c0866';

export async function sendToN8N(event: string, tenantId: string, data: any) {
  if (tenantId !== CARLOS_ROMERO_TENANT_ID) {
    return; // Solo enviar para Peluquería Carlos Romero
  }

  try {
    console.log(`[n8n Integration] Enviando evento '${event}' a n8n...`);
    
    let payload: any = {
      event,
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      tenant_name: 'Peluquería Carlos Romero'
    };

    if (event === 'call_ended') {
      const cleanPhone = (data.caller_phone || '').split('|')[0].trim();
      payload.call = {
        id: data.id || '',
        phone: cleanPhone,
        duration_seconds: data.call_duration || 0,
        recording_url: data.recording_url || '',
        transcript: data.transcript || '',
        summary: data.summary || '',
        intent_tag: data.intent_tag || 'Consulta General'
      };
    } else {
      let date = data.date;
      let time = data.time;
      if (data.date_time && (!date || !time)) {
        const dt = new Date(data.date_time);
        date = dt.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
        time = dt.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false });
      }

      payload.appointment = {
        id: data.id || '',
        name: data.patient_name || data.name || '',
        phone: data.patient_phone || data.phone || '',
        email: data.patient_email || data.email || '',
        date_time: data.date_time,
        date: date || '',
        time: time || '',
        specialty: data.specialty || '',
        status: data.status || 'confirmed',
        google_event_id: data.google_event_id || '',
        professional_name: data.professional_name || ''
      };
    }

    await axios.post(N8N_WEBHOOK_URL, payload);
    console.log('[n8n Integration] Evento enviado con éxito a n8n.');
  } catch (error: any) {
    console.error('[n8n Integration Error] Fallo al enviar webhook a n8n:', error.response?.data || error.message);
  }
}
