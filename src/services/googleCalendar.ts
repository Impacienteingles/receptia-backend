import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { getSettingVal } from './supabase';


// Rutas a las credenciales
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

// Alcances requeridos para Google Calendar
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/**
 * Obtiene una instancia configurada de OAuth2Client.
 */
export async function getOAuth2Client() {
  const clientId = await getSettingVal('GOOGLE_CLIENT_ID');
  const clientSecret = await getSettingVal('GOOGLE_CLIENT_SECRET');
  const redirectUri = await getSettingVal('GOOGLE_REDIRECT_URI') || 'http://localhost:3000/oauth2callback';

  if (clientId && clientSecret) {
    return new google.auth.OAuth2(
      clientId,
      clientSecret,
      redirectUri
    );
  }

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `El archivo credentials.json no existe en la raíz del proyecto y tampoco se configuraron las variables de entorno GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET.`
    );
  }

  const credentialsContent = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  const credentials = JSON.parse(credentialsContent);
  
  // Soporta tanto el formato de credenciales "web" como "installed" (escritorio) de Google
  const creds = credentials.web || credentials.installed;
  if (!creds) {
    throw new Error('El archivo credentials.json no tiene una estructura válida ("web" o "installed").');
  }

  const { client_secret, client_id, redirect_uris } = creds;
  
  return new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0] || 'http://localhost:3000/oauth2callback'
  );
}

/**
 * Inicializa el cliente de Google Calendar para un inquilino específico a partir de su refresh_token.
 */
export async function getCalendarClient(refreshToken: string) {
  const oAuth2Client = await getOAuth2Client();
  oAuth2Client.setCredentials({
    refresh_token: refreshToken
  });
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

/**
 * Genera la URL de autorización de Google.
 * Recibe un state opcional para asociar el callback al tenant correspondiente.
 */
export async function getAuthUrl(state?: string) {
  const oAuth2Client = await getOAuth2Client();
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state: state
  });
}

/**
 * Intercambia el código de autorización por un token de Google.
 */
export async function getTokensFromCode(code: string) {
  const oAuth2Client = await getOAuth2Client();
  const { tokens } = await oAuth2Client.getToken(code);
  return tokens;
}

/**
 * Convierte una fecha y hora local de Madrid a un objeto Date absoluto (en UTC).
 * Esto evita desajustes horariios cuando el servidor corre en otra zona horaria (e.g. UTC/Oregon).
 */
export function getMadridDate(dateStr: string, timeStr: string): Date {
  const date = new Date(`${dateStr}T${timeStr}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });
  
  const getMadridParts = (d: Date) => {
    const parts = formatter.formatToParts(d);
    const p: any = {};
    parts.forEach(pt => p[pt.type] = pt.value);
    return new Date(Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour) === 24 ? 0 : Number(p.hour),
      Number(p.minute),
      Number(p.second)
    ));
  };

  const targetUTC = new Date(Date.UTC(
    Number(dateStr.split('-')[0]),
    Number(dateStr.split('-')[1]) - 1,
    Number(dateStr.split('-')[2]),
    Number(timeStr.split(':')[0]),
    Number(timeStr.split(':')[1])
  ));

  const localTimeComponent = getMadridParts(date);
  const diff = targetUTC.getTime() - localTimeComponent.getTime();
  return new Date(date.getTime() + diff);
}

/**
 * Define los slots laborables disponibles en la clínica para una fecha dada.
 * Horario: 09:00 a 14:00 y 16:00 a 20:00 (Español)
 * Duración: 30 minutos por slot.
 */
function getWorkingSlots(dateStr: string, slotDurationMin: number = 30): Date[] {
  const slots: Date[] = [];
  const stepMs = slotDurationMin * 60 * 1000;
  
  // Turno mañana: 09:00 a 14:00 (último slot termina a las 14:00)
  let current = getMadridDate(dateStr, '09:00');
  const limitManana = getMadridDate(dateStr, '14:00');
  while (current.getTime() + stepMs <= limitManana.getTime()) {
    slots.push(new Date(current.getTime()));
    current.setTime(current.getTime() + stepMs);
  }
  
  // Turno tarde: 16:00 a 20:00 (último slot termina a las 20:00)
  current = getMadridDate(dateStr, '16:00');
  const limitTarde = getMadridDate(dateStr, '20:00');
  while (current.getTime() + stepMs <= limitTarde.getTime()) {
    slots.push(new Date(current.getTime()));
    current.setTime(current.getTime() + stepMs);
  }

  return slots;
}

/**
 * Genera slots laborables dinámicamente según el horario semanal guardado en formato JSONB.
 */
function getWorkingSlotsDynamic(dateStr: string, workingHours: any, slotDurationMin: number = 30): Date[] {
  const slots: Date[] = [];
  const stepMs = slotDurationMin * 60 * 1000;
  
  // Obtener el día de la semana de la fecha dada en la zona horaria de Madrid
  const madridDate = getMadridDate(dateStr, '12:00');
  const dayName = madridDate.toLocaleDateString('en-US', { timeZone: 'Europe/Madrid', weekday: 'long' }).toLowerCase();

  // Obtener intervalos del día
  const dayShifts = workingHours?.[dayName] || [];
  if (dayShifts.length === 0) {
    return []; // Cerrado
  }

  for (const shift of dayShifts) {
    const { start, end } = shift; // ej: "09:00", "14:00"
    if (!start || !end) continue;

    let current = getMadridDate(dateStr, start);
    const limit = getMadridDate(dateStr, end);

    while (current.getTime() + stepMs <= limit.getTime()) {
      slots.push(new Date(current.getTime()));
      current.setTime(current.getTime() + stepMs);
    }
  }

  return slots;
}

/**
 * Verifica si agendar una cita en el rango [slotStart, slotEnd] infringe la regla de descansos consecutivos de Peluquería Carlos Romero:
 * "Cada dos bloques de trabajo (30 min total), debe quedar 1 bloque libre (15 min) de descanso,
 * excepto cuando sea una sola cita de 3 o 4 bloques."
 */
function checkConsecutiveBlockRule(
  slotStart: number,
  slotEnd: number,
  events: any[]
): boolean {
  let backwardDuration = 0;
  let backwardCount = 0;
  let currentStart = slotStart;
  let found = true;

  while (found) {
    found = false;
    for (const event of events) {
      if (!event.start?.dateTime || !event.end?.dateTime) continue;
      const eventStart = new Date(event.start.dateTime).getTime();
      const eventEnd = new Date(event.end.dateTime).getTime();
      // Si el evento termina justo donde empieza nuestro bloque actual
      if (Math.abs(eventEnd - currentStart) < 1000) {
        backwardDuration += (eventEnd - eventStart);
        backwardCount++;
        currentStart = eventStart;
        found = true;
        break;
      }
    }
  }

  let forwardDuration = 0;
  let forwardCount = 0;
  let currentEnd = slotEnd;
  found = true;

  while (found) {
    found = false;
    for (const event of events) {
      if (!event.start?.dateTime || !event.end?.dateTime) continue;
      const eventStart = new Date(event.start.dateTime).getTime();
      const eventEnd = new Date(event.end.dateTime).getTime();
      // Si el evento empieza justo donde termina nuestro bloque actual
      if (Math.abs(eventStart - currentEnd) < 1000) {
        forwardDuration += (eventEnd - eventStart);
        forwardCount++;
        currentEnd = eventEnd;
        found = true;
        break;
      }
    }
  }

  const totalDurationMin = ((slotEnd - slotStart) + backwardDuration + forwardDuration) / (60 * 1000);
  const totalSeparateApps = 1 + backwardCount + forwardCount;

  // Si hay más de una cita distinta encadenada y la duración total combinada supera los 30 minutos (2 bloques)
  if (totalSeparateApps > 1 && totalDurationMin > 30) {
    return true; // Bloqueado
  }

  return false;
}

/**
 * Obtiene los huecos libres para una fecha específica.
 */
export async function listFreeSlots(
  refreshToken: string, 
  dateStr: string, 
  workingHours?: any, 
  calendarId?: string,
  slotDurationMin: number = 30,
  applyPeluqueriaBreakRule: boolean = false
) {
  const calendar = await getCalendarClient(refreshToken);
  const targetCalendarId = calendarId || 'primary';
  
  // Definir rango del día completo
  const timeMin = new Date(`${dateStr}T00:00:00Z`).toISOString();
  const timeMax = new Date(`${dateStr}T23:59:59Z`).toISOString();

  // Obtener los eventos del día
  const response = await calendar.events.list({
    calendarId: targetCalendarId,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = response.data.items || [];
  const workingSlots = workingHours 
    ? getWorkingSlotsDynamic(dateStr, workingHours, slotDurationMin)
    : getWorkingSlots(dateStr, slotDurationMin);
  const freeSlots: string[] = [];
  const stepMs = slotDurationMin * 60 * 1000;

  // Filtrar los slots de trabajo que no colisionan con eventos del calendario
  for (const slot of workingSlots) {
    const slotStart = slot.getTime();
    const slotEnd = slotStart + stepMs;

    const isBusy = events.some((event: any) => {
      if (!event.start?.dateTime || !event.end?.dateTime) return false;
      const eventStart = new Date(event.start.dateTime).getTime();
      const eventEnd = new Date(event.end.dateTime).getTime();

      // Comprobar solapamiento
      return (slotStart < eventEnd && slotEnd > eventStart);
    });

    if (!isBusy) {
      // Si aplica la regla de descansos de Peluquería Carlos Romero, comprobarla
      if (applyPeluqueriaBreakRule && checkConsecutiveBlockRule(slotStart, slotEnd, events)) {
        continue; // Omitir esta ranura
      }

      // Formatear hora legible en español (ej: "09:30", "16:00")
      const timeString = slot.toLocaleTimeString('es-ES', {
        timeZone: 'Europe/Madrid',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      freeSlots.push(timeString);
    }
  }

  return freeSlots;
}

/**
 * Reserva una cita médica en el calendario.
 */
export async function bookAppointment(
  refreshToken: string,
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
  durationMinutes: number = 30,
  isPendingPayment: boolean = false
) {
  const calendar = await getCalendarClient(refreshToken);
  const targetCalendarId = calendarId || 'primary';
  
  // Calcular hora de inicio y fin tratando la entrada como UTC para evitar desajustes de zona horaria local del servidor
  const startParsed = new Date(`${dateStr}T${timeStr}:00Z`);
  const endParsed = new Date(startParsed.getTime() + durationMinutes * 60 * 1000);

  const startLocalStr = `${dateStr}T${timeStr}:00`;
  const endLocalStr = `${endParsed.getUTCFullYear()}-${String(endParsed.getUTCMonth() + 1).padStart(2, '0')}-${String(endParsed.getUTCDate()).padStart(2, '0')}T${String(endParsed.getUTCHours()).padStart(2, '0')}:${String(endParsed.getUTCMinutes()).padStart(2, '0')}:00`;

  // Determinar etiquetas según el sector del negocio
  const nameLower = (businessName || '').toLowerCase();
  const isClinic = businessSector === 'clinica' || 
                   nameLower.includes('médica') || 
                   nameLower.includes('medica') || 
                   nameLower.includes('sanasalud') || 
                   nameLower.includes('salud') || 
                   nameLower.includes('clinic') || 
                   nameLower.includes('doctor') || 
                   nameLower.includes('dent');
                   
  const isPeluqueria = businessSector === 'peluqueria' || 
                       nameLower.includes('peluquería') || 
                       nameLower.includes('peluqueria') || 
                       nameLower.includes('barber') || 
                       nameLower.includes('corte');

  let labelSummary = `Reserva Cita - ${specialty}`;
  if (isClinic) {
    labelSummary = `Cita Médica - ${specialty}`;
  } else if (isPeluqueria) {
    labelSummary = `Cita Peluquería - ${specialty}`;
  }

  if (isPendingPayment) {
    labelSummary = `[PENDIENTE DE PAGO] ${labelSummary}`;
  }

  const labelPerson = isClinic ? 'Paciente' : 'Cliente';
  const labelSpecialty = isClinic ? 'Especialidad' : 'Servicio';
  const description = `${labelPerson}: ${name}\nTeléfono: ${phone}\nEmail: ${email || 'No proporcionado'}\n${labelSpecialty}: ${specialty}\nReserva gestionada por ${businessName || 'el asistente virtual'}.`;

  const event: any = {
    summary: labelSummary,
    description: description,
    start: {
      dateTime: startLocalStr,
      timeZone: 'Europe/Madrid',
    },
    end: {
      dateTime: endLocalStr,
      timeZone: 'Europe/Madrid',
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 },
        { method: 'popup', minutes: 30 },
      ],
    },
  };

  if (email && email.trim() !== '' && email.includes('@')) {
    event.attendees = [{ email: email }];
  }

  const response = await calendar.events.insert({
    calendarId: targetCalendarId,
    requestBody: event,
    sendUpdates: 'all', // Envía invitación por email al paciente
  });

  return response.data;
}

/**
 * Actualiza una cita existente en el calendario de Google.
 */
export async function updateAppointment(
  refreshToken: string,
  eventId: string,
  dateStr: string,
  timeStr: string,
  name: string,
  email: string,
  phone: string,
  specialty: string,
  calendarId?: string,
  businessName?: string,
  businessSector?: string,
  durationMinutes: number = 30
) {
  const calendar = await getCalendarClient(refreshToken);
  const targetCalendarId = calendarId || 'primary';
  
  // Calcular hora de inicio y fin tratando la entrada como UTC para evitar desajustes de zona horaria local del servidor
  const startParsed = new Date(`${dateStr}T${timeStr}:00Z`);
  const endParsed = new Date(startParsed.getTime() + durationMinutes * 60 * 1000);

  const startLocalStr = `${dateStr}T${timeStr}:00`;
  const endLocalStr = `${endParsed.getUTCFullYear()}-${String(endParsed.getUTCMonth() + 1).padStart(2, '0')}-${String(endParsed.getUTCDate()).padStart(2, '0')}T${String(endParsed.getUTCHours()).padStart(2, '0')}:${String(endParsed.getUTCMinutes()).padStart(2, '0')}:00`;

  // Determinar etiquetas según el sector del negocio
  const nameLower = (businessName || '').toLowerCase();
  const isClinic = businessSector === 'clinica' || 
                   nameLower.includes('médica') || 
                   nameLower.includes('medica') || 
                   nameLower.includes('sanasalud') || 
                   nameLower.includes('salud') || 
                   nameLower.includes('clinic') || 
                   nameLower.includes('doctor') || 
                   nameLower.includes('dent');
                   
  const isPeluqueria = businessSector === 'peluqueria' || 
                       nameLower.includes('peluquería') || 
                       nameLower.includes('peluqueria') || 
                       nameLower.includes('barber') || 
                       nameLower.includes('corte');

  let labelSummary = `Reserva Cita - ${specialty}`;
  if (isClinic) {
    labelSummary = `Cita Médica - ${specialty}`;
  } else if (isPeluqueria) {
    labelSummary = `Cita Peluquería - ${specialty}`;
  }

  const labelPerson = isClinic ? 'Paciente' : 'Cliente';
  const labelSpecialty = isClinic ? 'Especialidad' : 'Servicio';
  const description = `${labelPerson}: ${name}\nTeléfono: ${phone}\nEmail: ${email || 'No proporcionado'}\n${labelSpecialty}: ${specialty}\nReserva gestionada por ${businessName || 'el asistente virtual'}.`;

  const event: any = {
    summary: labelSummary,
    description: description,
    start: {
      dateTime: startLocalStr,
      timeZone: 'Europe/Madrid',
    },
    end: {
      dateTime: endLocalStr,
      timeZone: 'Europe/Madrid',
    },
  };

  if (email && email.trim() !== '' && email.includes('@')) {
    event.attendees = [{ email: email }];
  }

  const response = await calendar.events.patch({
    calendarId: targetCalendarId,
    eventId: eventId,
    requestBody: event,
    sendUpdates: 'all', // Envía correo de actualización al paciente
  });

  return response.data;
}

/**
 * Elimina una cita médica del calendario de Google.
 */
export async function deleteAppointment(
  refreshToken: string,
  eventId: string,
  calendarId?: string
) {
  const calendar = await getCalendarClient(refreshToken);
  const targetCalendarId = calendarId || 'primary';
  
  await calendar.events.delete({
    calendarId: targetCalendarId,
    eventId: eventId,
    sendUpdates: 'all', // Envía correo de cancelación al paciente
  });
}
