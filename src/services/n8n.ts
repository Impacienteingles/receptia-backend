import axios from 'axios';

const CARLOS_ROMERO_TENANT_ID = '62d1ed82-287c-4329-941b-50b578c15b14';
const N8N_WEBHOOK_URL = 'https://corandar.app.n8n.cloud/webhook/90bf835d-5380-4779-b70d-745d068c0866';

export async function sendToN8N(event: string, tenantId: string, appointmentData: any) {
  if (tenantId !== CARLOS_ROMERO_TENANT_ID) {
    return; // Solo enviar para Peluquería Carlos Romero
  }

  try {
    console.log(`[n8n Integration] Enviando evento '${event}' a n8n...`);
    
    let date = appointmentData.date;
    let time = appointmentData.time;
    if (appointmentData.date_time && (!date || !time)) {
      const dt = new Date(appointmentData.date_time);
      // Formatear en horario local de España para facilitar el trabajo del cliente en n8n
      date = dt.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
      time = dt.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false });
    }

    const payload = {
      event,
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      tenant_name: 'Peluquería Carlos Romero',
      appointment: {
        id: appointmentData.id,
        name: appointmentData.patient_name || appointmentData.name || '',
        phone: appointmentData.patient_phone || appointmentData.phone || '',
        email: appointmentData.patient_email || appointmentData.email || '',
        date_time: appointmentData.date_time,
        date: date || '',
        time: time || '',
        specialty: appointmentData.specialty || '',
        status: appointmentData.status || 'confirmed',
        google_event_id: appointmentData.google_event_id || '',
        professional_name: appointmentData.professional_name || ''
      }
    };

    await axios.post(N8N_WEBHOOK_URL, payload);
    console.log('[n8n Integration] Evento enviado con éxito a n8n.');
  } catch (error: any) {
    console.error('[n8n Integration Error] Fallo al enviar webhook a n8n:', error.response?.data || error.message);
  }
}
