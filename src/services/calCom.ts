import axios from 'axios';

function getEventTypeId(durationMinutes: number): number {
  if (durationMinutes <= 15) return 6283579; // Cita Peluquería (15 min)
  return 6283577; // Reunión de 30 min (30 min)
}


/**
 * Consulta la disponibilidad de slots libres en Cal.com (API v2)
 * Firma compatible con la firma original de listFreeSlots en googleCalendar.ts
 */
export async function listFreeSlotsCalCom(
  apiKey: string,
  dateStr: string,
  workingHours?: any,
  calendarId?: string,
  slotDurationMinutes: number = 15,
  applyBreakRule?: boolean,
  agendaOptimization?: boolean
): Promise<string[]> {
  try {
    const eventTypeId = getEventTypeId(slotDurationMinutes);
    const startTime = `${dateStr}T00:00:00.000Z`;
    const endTime = `${dateStr}T23:59:59.000Z`;

    console.log(`[Cal.com API] Consultando slots para eventTypeId ${eventTypeId} del ${dateStr}...`);

    const response = await axios.get(`https://api.cal.com/v2/slots/available`, {
      params: {
        eventTypeId,
        startTime,
        endTime
      },
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'cal-api-version': '2024-08-13'
      }
    });

    if (response.data?.status !== 'success' || !response.data.data?.slots) {
      console.warn('[Cal.com API Warning] Estructura de slots vacía o errónea:', response.data);
      return [];
    }

    const slotsMap = response.data.data.slots;
    const slotsList = slotsMap[dateStr] || [];

    // Convertir los slots UTC a la hora local de Madrid (HH:MM)
    const localSlots = slotsList.map((slot: any) => {
      const dateObj = new Date(slot.time);
      return dateObj.toLocaleTimeString('es-ES', {
        timeZone: 'Europe/Madrid',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    });

    let filteredSlots = localSlots;
    if (applyBreakRule) {
      const breaks = ['10:30', '11:15', '12:00', '12:45', '13:30', '17:30', '18:15', '19:00', '19:45'];
      filteredSlots = localSlots.filter((slotTime: string) => !breaks.includes(slotTime));
    }

    // Si la fecha consultada es HOY, filtrar los slots que ya hayan pasado
    const now = new Date();
    const madridToday = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }); // YYYY-MM-DD en Madrid
    
    if (dateStr === madridToday) {
      const currentMadridTime = now.toLocaleTimeString('es-ES', {
        timeZone: 'Europe/Madrid',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      return filteredSlots.filter((slotTime: string) => slotTime > currentMadridTime);
    }

    return filteredSlots;
  } catch (error: any) {
    console.error('[Cal.com API Error] Error al listar slots libres:', error.response?.data || error.message);
    return [];
  }
}

/**
 * Registra una nueva reserva (booking) en Cal.com (API v2)
 * Firma compatible con la firma original de bookAppointment en googleCalendar.ts
 */
export async function bookAppointmentCalCom(
  apiKey: string,
  dateStr: string,
  timeStr: string,
  name: string,
  email: string,
  phone: string,
  specialty: string,
  calendarId?: string,
  agentName?: string,
  businessName?: string,
  businessSector?: string,
  durationMinutes: number = 15,
  isPendingPayment?: boolean
): Promise<any> {
  try {
    const eventTypeId = getEventTypeId(durationMinutes);
    
    // Cal.com espera la fecha de inicio en formato ISO 8601 UTC o con offset
    const startIso = `${dateStr}T${timeStr}:00+02:00`; // Zona horaria de España/Madrid (UTC+2)

    console.log(`[Cal.com API] Reservando cita el ${dateStr} a las ${timeStr} (eventTypeId ${eventTypeId})...`);

    const payload = {
      eventTypeId,
      start: startIso,
      attendee: {
        name,
        email: email && email.includes('@') ? email : 'no-responder@receptia.com',
        timeZone: 'Europe/Madrid',
        language: 'es',
        phoneNumber: phone
      },
      metadata: {
        specialty,
        source: 'Receptia Vapi Agent',
        isPendingPayment: isPendingPayment ? 'true' : 'false'
      }
    };

    const response = await axios.post(`https://api.cal.com/v2/bookings`, payload, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'cal-api-version': '2024-08-13'
      }
    });

    const booking = response.data.data;

    // Retornar un objeto compatible con el formato que espera el resto de Receptia
    return {
      id: booking.uid,
      status: 'confirmed',
      start: {
        dateTime: booking.start
      },
      end: {
        dateTime: booking.end
      },
      summary: booking.title,
      description: booking.description,
      google_event_id: booking.uid,
      google_calendar_id: 'cal.com'
    };
  } catch (error: any) {
    console.error('[Cal.com API Error] Fallo al crear reserva:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error?.message || 'Error al agendar cita en Cal.com');
  }
}

/**
 * Cancela una reserva (booking) existente en Cal.com (API v2)
 * Firma compatible con la firma original de deleteAppointment en googleCalendar.ts
 */
export async function deleteAppointmentCalCom(
  apiKey: string,
  bookingUid: string,
  calendarId?: string
): Promise<void> {
  try {
    console.log(`[Cal.com API] Cancelando reserva: ${bookingUid}...`);

    await axios.post(`https://api.cal.com/v2/bookings/${bookingUid}/cancel`, {
      cancellationReason: 'Cancelación solicitada por el cliente por teléfono.'
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'cal-api-version': '2024-08-13'
      }
    });
    console.log(`[Cal.com API] Reserva ${bookingUid} cancelada correctamente.`);
  } catch (error: any) {
    console.error('[Cal.com API Error] Fallo al cancelar reserva:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error?.message || 'Error al cancelar cita en Cal.com');
  }
}

/**
 * Reprograma una reserva (booking) existente en Cal.com (API v2)
 * Firma compatible con la firma original de updateAppointment en googleCalendar.ts
 */
export async function updateAppointmentCalCom(
  apiKey: string,
  bookingUid: string,
  newDateStr: string,
  newTimeStr: string,
  name?: string,
  email?: string,
  phone?: string,
  specialty?: string,
  calendarId?: string,
  businessName?: string,
  businessSector?: string,
  durationMinutes?: number
): Promise<any> {
  try {
    console.log(`[Cal.com API] Reprogramando reserva ${bookingUid} al ${newDateStr} a las ${newTimeStr}...`);
    
    const startIso = `${newDateStr}T${newTimeStr}:00+02:00`; // Zona horaria de España/Madrid (UTC+2)

    const response = await axios.post(`https://api.cal.com/v2/bookings/${bookingUid}/reschedule`, {
      start: startIso,
      reschedulingReason: 'Modificación solicitada por el cliente por teléfono.'
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'cal-api-version': '2024-08-13'
      }
    });

    const booking = response.data.data;

    return {
      id: booking.uid,
      status: 'confirmed',
      start: {
        dateTime: booking.start
      },
      end: {
        dateTime: booking.end
      },
      summary: booking.title,
      description: booking.description,
      google_event_id: booking.uid,
      google_calendar_id: 'cal.com'
    };
  } catch (error: any) {
    console.error('[Cal.com API Error] Fallo al reprogramar reserva:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error?.message || 'Error al reprogramar cita en Cal.com');
  }
}
