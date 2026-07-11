import { Router, Request, Response } from 'express';
import { listFreeSlotsCalCom as listFreeSlots, bookAppointmentCalCom as bookAppointment, deleteAppointmentCalCom as deleteAppointment, updateAppointmentCalCom as updateAppointment } from '../services/calCom';
import { supabase } from '../services/supabase';
import { sendWhatsAppMessage } from '../services/whatsapp';
import { processMeteredBillingForCall } from '../services/stripe';
import { processBookingFlow } from '../services/booking-flow';
import { sendToN8N } from '../services/n8n';

const router = Router();

function isSlotBlocked(slotTimeStr: string, queryDateStr: string, rules: any[]): boolean {
  try {
    const queryDate = new Date(queryDateStr + 'T00:00:00');
    const queryDayOfWeek = queryDate.getDay(); // 0 (Domingo) - 6 (Sabado)
    const queryDayOfMonth = queryDate.getDate();

    for (const rule of rules) {
      let matchesDate = false;

      if (rule.recurrence === 'none') {
        if (rule.block_date === queryDateStr) {
          matchesDate = true;
        }
      } else if (rule.recurrence === 'always') {
        matchesDate = true;
      } else if (rule.recurrence === 'weekly') {
        if (rule.block_date && rule.block_date.includes('-')) {
          // Bloqueo de semana completa específica (block_date guarda el lunes de esa semana)
          const mondayDate = new Date(rule.block_date + 'T00:00:00');
          const sundayDate = new Date(mondayDate.getTime() + 6 * 24 * 60 * 60 * 1000);
          const qTime = queryDate.getTime();
          const mTime = mondayDate.getTime();
          const sTime = sundayDate.getTime();

          if (qTime >= mTime && qTime <= sTime) {
            matchesDate = true;
          }
        } else if (rule.day_of_week !== null && rule.day_of_week !== undefined) {
          if (Number(rule.day_of_week) === queryDayOfWeek) {
            matchesDate = true;
          }
        }
      } else if (rule.recurrence === 'monthly') {
        if (rule.block_date && rule.block_date.includes('-')) {
          // Bloqueo de mes completo específico (block_date es el primer día de ese mes, ej. 2026-07-01)
          const [rYear, rMonth] = rule.block_date.split('-');
          const qYear = queryDate.getFullYear();
          const qMonth = queryDate.getMonth() + 1;

          if (Number(rYear) === qYear && Number(rMonth) === qMonth) {
            matchesDate = true;
          }
        } else if (rule.block_date) {
          const ruleDayOfMonth = new Date(rule.block_date + 'T00:00:00').getDate();
          if (ruleDayOfMonth === queryDayOfMonth) {
            matchesDate = true;
          }
        }
      }

      if (matchesDate) {
        const start = rule.start_time.substring(0, 5);
        const end = rule.end_time.substring(0, 5);
        const target = slotTimeStr.substring(0, 5);
        if (target >= start && target < end) {
          return true;
        }
      }
    }
  } catch (err: any) {
    console.error('Error checking isSlotBlocked:', err.message);
  }
  return false;
}


/**
 * Función auxiliar para obtener detalles de conexión de un inquilino desde Supabase.
 */
async function getTenantDetailsForWebhook(tenantId: string) {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();

  if (error || !data) {
    throw new Error(`Inquilino no encontrado (${tenantId}) o error en BD: ${error?.message || 'Sin datos'}`);
  }

  if (!data.google_refresh_token) {
    throw new Error(`El inquilino con ID ${tenantId} no ha vinculado su Google Calendar todavía.`);
  }

  let workingHoursObj = data.working_hours;
  if (typeof workingHoursObj === 'string') {
    try { workingHoursObj = JSON.parse(workingHoursObj); } catch (e) {}
  }

  let isImmediateEnabled = true;
  if (data.whatsapp_immediate_notification_enabled !== undefined && data.whatsapp_immediate_notification_enabled !== null) {
    isImmediateEnabled = data.whatsapp_immediate_notification_enabled !== false;
  } else if (workingHoursObj && workingHoursObj.whatsapp_immediate_notification_enabled !== undefined) {
    isImmediateEnabled = workingHoursObj.whatsapp_immediate_notification_enabled !== false;
  }

  return {
    ...data,
    whatsapp_immediate_notification_enabled: isImmediateEnabled
  };
}

/**
 * Función auxiliar para obtener únicamente el token de refresco.
 */
async function getRefreshTokenForTenant(tenantId: string): Promise<string> {
  const details = await getTenantDetailsForWebhook(tenantId);
  return details.google_refresh_token;
}

/**
 * Función para resolver el tenant_id, con fallback al primer inquilino de la base de datos para pruebas.
 */
async function resolveTenantId(req: Request): Promise<string> {
  let tenantId = req.query.tenant_id as string;
  
  if (!tenantId) {
    console.warn('⚠️ No se proporcionó tenant_id en la query del webhook. Buscando inquilino de prueba...');
    const { data: tenants, error: dbError } = await supabase
      .from('tenants')
      .select('id')
      .limit(1);
    
    if (dbError || !tenants || tenants.length === 0) {
      throw new Error('Falta el parámetro tenant_id en la URL y no se encontraron inquilinos registrados en la base de datos.');
    }
    
    tenantId = tenants[0].id;
    console.log(`Usando tenant_id por defecto/prueba: ${tenantId}`);
  }
  
  return tenantId;
}

/**
 * Calcula la duración estimada de la cita en base a la especialidad/servicio solicitado y el inquilino.
 * Para Peluquería Carlos Romero (tenant_id = '62d1ed82-287c-4329-941b-50b578c15b14'):
 * - Corte de caballero y tres niños: 4 bloques = 60 minutos
 * - Corte de caballero y dos niños: 3 bloques = 45 minutos
 * - Corte de caballero y un niño: 2 bloques = 30 minutos
 * - Corte de caballero / Corte de niño: 1 bloque = 15 minutos
 */
function calculateDuration(specialty: string, tenantId: string): number {
  if (tenantId !== '62d1ed82-287c-4329-941b-50b578c15b14') {
    return 30; // 30 minutos por defecto para otros clientes
  }

  const text = (specialty || '').toLowerCase();
  
  // Contar personas de forma dinámica y matemática
  let persons = 1;
  
  // Buscar palabras de números escritos o dígitos
  if (text.includes('cuatro') || text.includes('4')) {
    persons = 4;
  } else if (text.includes('tres') || text.includes('3') || text.includes('dos hijos') || text.includes('dos niños') || text.includes('2 hijos') || text.includes('2 niños')) {
    persons = 3;
  } else if (text.includes('dos') || text.includes('2') || text.includes('un hijo') || text.includes('un niño') || text.includes('1 hijo') || text.includes('1 niño')) {
    persons = 2;
  }
  
  // Caso especial: "hijo y yo" o "niño y yo" son 2 personas
  if (text.includes('hijo y yo') || text.includes('niño y yo') || text.includes('acompañante y yo')) {
    persons = 2;
  }
  
  // Caso especial: "mis dos hijos y yo" o "mis 2 hijos y yo" o "yo y mis dos hijos" son 3 personas
  if (text.includes('dos hijos y yo') || text.includes('2 hijos y yo') || text.includes('dos niños y yo') || text.includes('2 niños y yo') || text.includes('yo y mis dos hijos') || text.includes('yo y mis 2 hijos')) {
    persons = 3;
  }

  return persons * 15; // Cada servicio dura 15 minutos en Carlos Romero (1 bloque = 15 min)
}

/**
 * Endpoint para que Retell AI consulte los huecos libres.
 * Se espera que el LLM llame a esta función pasando la fecha (YYYY-MM-DD).
 */
router.post('/get-availability', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('Webhook recibido para get-availability:', JSON.stringify(req.body));
    
    // Retell AI pasa los argumentos en req.body.args
    const args = req.body.args || req.body || {};
    const date = args.date;
    const time = args.time; // Opcional de la IA para validación estricta cerrado/ocupado
    const professional = args.professional; // Opcional de la IA

    if (!date) {
      res.status(400).json({ error: 'La fecha es obligatoria.' });
      return;
    }

    // Verificar formato de fecha básico (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      res.status(400).json({ error: 'Formato de fecha inválido. Debe ser YYYY-MM-DD.' });
      return;
    }

    // Resolver tenant_id y su refresh token
    const tenantId = await resolveTenantId(req);
    const tenantDetails = await getTenantDetailsForWebhook(tenantId);

    if (!tenantDetails.google_refresh_token) {
      console.warn(`[get-availability] El inquilino ${tenantId} no tiene Google Calendar conectado.`);
      res.json({
        status: 'success',
        available_slots: [],
        message: 'No se puede consultar disponibilidad ni agendar citas porque el cliente aún no ha conectado su Google Calendar. Por favor, indícale al usuario de forma clara y amable que debe iniciar sesión en el panel y conectar Google Calendar en la pestaña Inicio.'
      });
      return;
    }

    // Mapear calendario del profesional si está activo
    let calendarId = 'primary';
    const clientEnableMulti = tenantDetails.working_hours?.client_enable_multi_professional !== false;
    const hasMultiProfPermission = tenantDetails.plan_id && !tenantDetails.plan_id.includes('inicial');
    if (hasMultiProfPermission && tenantDetails.enable_multi_professional && clientEnableMulti && tenantDetails.professionals && Array.isArray(tenantDetails.professionals)) {
      if (professional) {
        const prof = tenantDetails.professionals.find((p: any) => 
          p.name.toLowerCase().includes(String(professional).toLowerCase()) ||
          String(professional).toLowerCase().includes(p.name.toLowerCase())
        );
        if (prof) {
          calendarId = prof.calendar_id;
          console.log(`[Multi-Professional] Encontrado profesional: ${prof.name} -> Calendario: ${prof.calendar_id}`);
        } else {
          console.warn(`[Multi-Professional] Profesional no encontrado: ${professional}, usando primary`);
        }
      }
    }

    const isPeluqueria = tenantDetails.business_sector === 'peluqueria' || 
                         (tenantDetails.business_name && (
                           tenantDetails.business_name.toLowerCase().includes('peluquería') || 
                           tenantDetails.business_name.toLowerCase().includes('peluqueria') || 
                           tenantDetails.business_name.toLowerCase().includes('barber')
                         ));
    const slotDurationMin = isPeluqueria ? 15 : 30;
    let workingHoursObj = tenantDetails.working_hours;
    if (typeof workingHoursObj === 'string') {
      try { workingHoursObj = JSON.parse(workingHoursObj); } catch (e) {}
    }

    const specialty = args.specialty || '';
    const durationMinutes = calculateDuration(specialty, tenantId);
    const numBlocksNeeded = Math.ceil(durationMinutes / slotDurationMin);

    let applyBreakRule = tenantId === '62d1ed82-287c-4329-941b-50b578c15b14' || !!workingHoursObj?.apply_break_rule;
    
    // Si viene más de 2 personas (duración > 30 minutos en Carlos Romero), desactivamos la regla de descansos
    if (tenantId === '62d1ed82-287c-4329-941b-50b578c15b14' && durationMinutes > 30) {
      applyBreakRule = false;
      console.log(`[Peluquería Carlos Romero] Detectada reserva para más de 2 personas (Duración: ${durationMinutes} min). Desactivando regla de descansos.`);
    }

    console.log(`Buscando disponibilidad para la fecha: ${date} (Tenant: ${tenantId}) (Calendario: ${calendarId}) (Slot: ${slotDurationMin}m) (BreakRule: ${applyBreakRule})`);
    const freeSlots = await listFreeSlots(
      tenantDetails.google_refresh_token,
      date,
      tenantDetails.working_hours,
      calendarId,
      slotDurationMin,
      applyBreakRule,
      !!tenantDetails.agenda_optimization_enabled || !!workingHoursObj?.agenda_optimization_enabled
    );

    // Obtener horas bloqueadas de Supabase
    const { data: dbBlockedHours } = await supabase
      .from('blocked_hours')
      .select('*')
      .eq('tenant_id', tenantId);

    const blockedRules = dbBlockedHours || [];
    const nonBlockedSlots = freeSlots.filter((slot: string) => !isSlotBlocked(slot, date, blockedRules));

    // Resolver horario comercial de Supabase para esta fecha
    const targetDate = new Date(`${date}T12:00:00`);
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayNamesEs: any = {
      monday: 'Lunes',
      tuesday: 'Martes',
      wednesday: 'Miércoles',
      thursday: 'Jueves',
      friday: 'Viernes',
      saturday: 'Sábado',
      sunday: 'Domingo'
    };
    const dayOfWeek = dayNames[targetDate.getDay()];
    const dayNameEs = dayNamesEs[dayOfWeek];
    const shifts = workingHoursObj?.[dayOfWeek] || [];

    const parseTimeToMinutes = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const formatMinutesToTime = (m: number) => {
      const h = Math.floor(m / 60);
      const min = m % 60;
      return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    };

    // 1. Filtrar slots de Cal.com para asegurar que están estrictamente dentro de Supabase shifts (Horario Comercial)
    let actualOpenSlots = nonBlockedSlots;
    if (shifts.length > 0) {
      actualOpenSlots = nonBlockedSlots.filter((slotTime: string) => {
        const timeMin = parseTimeToMinutes(slotTime);
        return shifts.some((s: any) => {
          const startMin = parseTimeToMinutes(s.start);
          const endMin = parseTimeToMinutes(s.end);
          return timeMin >= startMin && timeMin < endMin;
        });
      });
    } else {
      actualOpenSlots = [];
    }

    // 2. Filtrar huecos libres según la duración requerida de la especialidad (bloques consecutivos)
    let filteredSlots = actualOpenSlots;

    if (numBlocksNeeded > 1 && actualOpenSlots.length > 0) {
      const resultSlots: string[] = [];
      for (let i = 0; i < actualOpenSlots.length; i++) {
        const currentSlot = actualOpenSlots[i];
        let consecutiveFound = true;
        const [hour, min] = currentSlot.split(':').map(Number);
        const nextTime = new Date(`1970-01-01T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`);

        for (let b = 1; b < numBlocksNeeded; b++) {
          nextTime.setUTCMinutes(nextTime.getUTCMinutes() + slotDurationMin);
          const nextTimeStr = nextTime.toISOString().substring(11, 16);
          if (!actualOpenSlots.includes(nextTimeStr)) {
            consecutiveFound = false;
            break;
          }
        }

        if (consecutiveFound) {
          resultSlots.push(currentSlot);
        }
      }
      filteredSlots = resultSlots;
    }
    
    console.log(`Huecos libres filtrados para duración ${durationMinutes} min: ${filteredSlots.join(', ')}`);
    
    let scheduleInfo = '';
    if (shifts.length === 0) {
      scheduleInfo = `El negocio está CERRADO todo el día el ${dayNameEs} (${date}).`;
    } else {
      const shiftsStr = shifts.map((s: any) => `de ${s.start} a ${s.end}`).join(' y ');
      scheduleInfo = `El horario comercial para el ${dayNameEs} (${date}) es únicamente: ${shiftsStr}. Todo horario fuera de este rango está cerrado.`;
    }

    const allDaySlots: string[] = [];
    const stepMin = slotDurationMin;
    for (const shift of shifts) {
      if (!shift.start || !shift.end) continue;
      let currentMin = parseTimeToMinutes(shift.start);
      const endMin = parseTimeToMinutes(shift.end);
      while (currentMin + stepMin <= endMin) {
        allDaySlots.push(formatMinutesToTime(currentMin));
        currentMin += stepMin;
      }
    }

    const busySlots = allDaySlots.filter(s => !filteredSlots.includes(s));

    const nowMadrid = new Date();
    const madridDateStr = nowMadrid.toLocaleDateString('es-ES', {
      timeZone: 'Europe/Madrid',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const madridTimeStr = nowMadrid.toLocaleTimeString('es-ES', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const prefixInfo = `[INFO DE REFERENCIA TEMPORAL REAL: La fecha y hora exactas de este momento en España son: ${madridDateStr} a las ${madridTimeStr}]. `;
    
    let timeStatusText = '';
    if (time) {
      const isTimeInShifts = (tStr: string, shiftsList: any[]) => {
        const timeMin = parseTimeToMinutes(tStr);
        return shiftsList.some((s: any) => {
          const startMin = parseTimeToMinutes(s.start);
          const endMin = parseTimeToMinutes(s.end);
          return timeMin >= startMin && timeMin < endMin;
        });
      };

      const isInOpeningHours = isTimeInShifts(time, shifts);
      if (!isInOpeningHours) {
        timeStatusText = `[DIRECTIVA CRÍTICA - REGLA DE HORA CERRADA]: La hora solicitada por el cliente (${time}) está FUERA del horario comercial del ${dayNameEs}. La peluquería está CERRADA en ese momento. Debes aplicar de forma estricta la REGLA 2 de tu prompt y decir exactamente la frase: "Lo siento, pero a esa hora la peluquería está cerrada" (nunca digas que está ocupado o que no hay disponibilidad). `;
      } else {
        if (filteredSlots.includes(time)) {
          timeStatusText = `[INFO]: La hora solicitada por el cliente (${time}) está LIBRE y disponible para reservar. `;
        } else {
          timeStatusText = `[DIRECTIVA CRÍTICA - REGLA DE HORA OCUPADA]: La hora solicitada por el cliente (${time}) está DENTRO de las horas de apertura del ${dayNameEs}, pero está OCUPADA (por descanso laboral o cita previa). Debes aplicar la REGLA 3 de tu prompt y decirle al cliente que la hora está ocupada o reservada (NUNCA le digas que está cerrada o fuera de horario). `;
        }
      }
    }

    const busySlotsInfoText = busySlots.length > 0
      ? `Los siguientes huecos están OCUPADOS o en el pasado y no se pueden reservar de ninguna manera: ${busySlots.join(', ')}.`
      : 'No hay huecos ocupados para hoy.';

    const messageText = filteredSlots.length > 0 
      ? `${timeStatusText}${prefixInfo}${busySlotsInfoText} Los siguientes huecos están libres y sí se pueden reservar: ${filteredSlots.join(', ')}. Nota de Horario: ${scheduleInfo}`
      : `${timeStatusText}${prefixInfo}${busySlotsInfoText} No hay huecos disponibles en esta fecha. Nota de Horario: ${scheduleInfo}. Sugiere al paciente otra fecha.`;

    res.json({
      status: 'success',
      available_slots: filteredSlots,
      busy_slots: busySlots,
      message: messageText,
      schedule_info: scheduleInfo
    });
  } catch (error: any) {
    console.error('Error en /get-availability:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});

/**
 * Endpoint para que la IA de Retell AI consulte silenciosamente los recuerdos de conversaciones previas
 * de los últimos 7 días asociados a este número de teléfono.
 */
router.post('/obtener-recuerdo-cliente', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('[Webhook Recuerdos] Recibida consulta de recuerdos...');
    
    // Retell AI envía metadatos de la llamada en req.body
    const args = req.body.args || req.body || {};
    
    // Resolver el teléfono del llamante desde varios posibles campos de Retell
    let phone = args.phone || req.body.caller_phone || req.body.user_phone_number || req.body.from_number || '';
    
    if (!phone && req.body.call) {
      phone = req.body.call.user_phone_number || req.body.call.from_number || '';
    }

    if (!phone) {
      console.warn('[Webhook Recuerdos] No se pudo identificar el número de teléfono del cliente.');
      res.json({
        status: 'success',
        memories: 'No hay conversaciones previas en los últimos 7 días con este número.'
      });
      return;
    }

    // Limpiar número de teléfono (quitar sufijos como |retell:callId si existieran)
    const cleanPhone = String(phone).split('|')[0].trim();
    
    // Resolver tenant_id
    const tenantId = await resolveTenantId(req);

    console.log(`[Webhook Recuerdos] Buscando recuerdos de los últimos 7 días para el teléfono: ${cleanPhone} (Tenant: ${tenantId})`);

    // Calcular la fecha límite de hace 7 días
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const dateLimitISO = sevenDaysAgo.toISOString();

    const { data: memories, error } = await supabase
      .from('caller_memories')
      .select('summary, created_at')
      .eq('tenant_id', tenantId)
      .eq('phone_number', cleanPhone)
      .gte('created_at', dateLimitISO)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Webhook Recuerdos ERROR] Error al consultar recuerdos en Supabase:', error.message);
      res.json({
        status: 'success',
        memories: 'No hay conversaciones previas en los últimos 7 días con este número.'
      });
      return;
    }

    if (!memories || memories.length === 0) {
      console.log(`[Webhook Recuerdos] No se encontraron recuerdos recientes para: ${cleanPhone}`);
      res.json({
        status: 'success',
        memories: 'No hay conversaciones previas en los últimos 7 días con este número.'
      });
      return;
    }

    // Formatear los recuerdos en un resumen legible para el LLM
    const formattedMemories = memories.map((m: any, idx: number) => {
      const dateStr = new Date(m.created_at).toLocaleDateString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      return `[Llamada ${idx + 1} - Fecha: ${dateStr}]: ${m.summary}`;
    }).join('\n');

    console.log(`[Webhook Recuerdos] Recuerdos encontrados y formateados:\n${formattedMemories}`);

    res.json({
      status: 'success',
      memories: formattedMemories
    });
  } catch (err: any) {
    console.error('[Webhook Recuerdos ERROR] Error general en endpoint:', err.message);
    res.json({
      status: 'success',
      memories: 'No hay conversaciones previas en los últimos 7 días con este número.'
    });
  }
});

/**
 * Resuelve el nombre humano del asistente virtual en base a su voice_id para usarlo en el calendario.
 */
function resolveAgentName(voiceId: string): string {
  if (!voiceId) return 'Elena';
  const id = voiceId.toLowerCase();
  if (id.includes('manuel')) return 'Manuel';
  if (id.includes('alejandro')) return 'Alejandro';
  if (id.includes('sarah')) return 'Sarah';
  if (id.includes('daniel')) return 'Daniel';
  if (id.includes('sofia')) return 'Sofía';
  if (id.includes('dani') || id.includes('7qqzpayz')) return 'Dani';
  if (id.includes('hailey') || id.includes('elena')) return 'Elena';
  if (id.includes('eryldjeaddain9sdjamx') || id.includes('gabriela') || id.includes('c3e5212df87e5341a06ad66e66')) return 'Gabriela';
  if (id.includes('cristina')) return 'Cristina';
  if (id.includes('alice') || id.includes('xb7h8msujpsbsdyk0k2')) return 'Alice';
  if (id.includes('jessica') || id.includes('cgsgspj2msm6clmckdw9')) return 'Jessica';
  if (id.includes('valeria') || id.includes('wwdaer5vld7sa27ddcli')) return 'Valeria';
  if (id.includes('carolina') || id.includes('z24cewyh9yhrpkmbku69')) return 'Carolina';
  return 'Elena';
}

/**
 * Resuelve el número de teléfono real del llamante si la IA ha pasado un placeholder o texto.
 */
function resolvePhoneNumber(phone: string, body: any): string {
  const trimmed = phone.trim();
  const lower = trimmed.toLowerCase();
  
  // Si contiene letras (por ejemplo "mismo", "llama", "este", "llamando"), es un placeholder de la IA
  const containsLetters = /[a-zA-Z]/.test(trimmed);
  
  if (
    containsLetters ||
    lower.includes('mismo') ||
    lower.includes('llama') ||
    lower.includes('este')
  ) {
    const fromNumber = body.call?.from_number || body.call?.user_phone_number;
    if (fromNumber) {
      console.log(`[Phone Resolver] Mapeado placeholder '${phone}' -> número real: ${fromNumber}`);
      return fromNumber;
    }
    // Fallback si no hay metadatos de teléfono real (ej: pruebas conversacionales sin número físico)
    console.warn(`[Phone Resolver] Detectado placeholder '${phone}' pero no se encontró un número real. Usando fallback.`);
    return '+34600000000';
  }
  
  return trimmed;
}

/**
 * Endpoint para que Retell AI cree una cita.
 */
router.post('/book-appointment', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('Webhook recibido para book-appointment:', JSON.stringify(req.body));
    
    const args = req.body.args || req.body || {};
    const { date, time, name, email, phone, professional, duration } = args;
    let specialty = args.specialty || 'Cita Peluquería';

    if (!date || !time || !name || !phone) {
      res.status(400).json({ 
        error: 'Todos los campos son requeridos: date, time, name, phone.' 
      });
      return;
    }

    const tenantId = await resolveTenantId(req);
    const tenantDetails = await getTenantDetailsForWebhook(tenantId);

    // Verificar si la hora está bloqueada
    const { data: dbBlockedHours } = await supabase
      .from('blocked_hours')
      .select('*')
      .eq('tenant_id', tenantId);

    const blockedRules = dbBlockedHours || [];
    if (isSlotBlocked(time, date, blockedRules)) {
      res.json({
        status: 'success',
        message: `El horario de las ${time} para el ${date} está reservado/bloqueado por el administrador y no admite citas. Por favor, sugiere otro horario al paciente.`
      });
      return;
    }

    const host = req.get('host') || '';
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
    const originUrl = `${protocol}://${host}`;

    const fromPhone = req.body.call?.from_number || req.body.call?.user_phone_number;

    const result = await processBookingFlow(tenantId, tenantDetails, args, originUrl, fromPhone);

    if (result.status === 'busy') {
      res.json({
        status: 'success',
        message: `El horario de las ${time} para el ${date} ya no está disponible. Huecos libres o error: ${result.message}`
      });
    } else if (result.status === 'payment_required') {
      res.json({
        status: 'success',
        message: `Se requiere un depósito de ${tenantDetails.no_show_deposit_amount || 10.00}€ para confirmar la cita. Le acabo de enviar un enlace de pago de Stripe por WhatsApp al teléfono. Por favor, realice el pago. Esperaré en línea un momento. Avíseme cuando lo haya hecho para verificarlo.`
      });
    } else {
      res.json({
        status: 'success',
        message: 'Cita agendada correctamente en el calendario. Confirma al paciente de forma natural que su cita ha sido reservada con éxito y que recibirá una confirmación por WhatsApp.'
      });
    }
  } catch (error: any) {
    console.error('Error en /book-appointment:', error);
    res.status(500).json({ 
      error: 'Error interno al reservar la cita', 
      details: error.message 
    });
  }
});

/**
 * Endpoint para que Retell AI verifique el estado del pago de la fianza.
 */
router.post('/verify-payment', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('Webhook recibido para verify-payment:', JSON.stringify(req.body));
    
    const args = req.body.args || req.body || {};
    const { phone } = args;

    if (!phone) {
      res.status(400).json({ error: 'El parámetro phone es obligatorio.' });
      return;
    }

    const tenantId = await resolveTenantId(req);
    const resolvedPhone = resolvePhoneNumber(phone, req.body.call?.from_number || req.body.call?.user_phone_number);
    const cleanPhone = resolvedPhone.split('|')[0].trim();

    console.log(`[Verify Payment] Buscando cita pagada para ${cleanPhone} (Tenant: ${tenantId})...`);

    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('tenant_id', tenantId)
      .or(`patient_phone.eq.${cleanPhone},patient_phone.like.${cleanPhone}%`)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      throw error;
    }

    if (!appointments || appointments.length === 0) {
      res.json({
        paid: false,
        message: 'No he encontrado ninguna cita registrada para este número de teléfono.'
      });
      return;
    }

    const latestApp = appointments[0];
    if (latestApp.status === 'confirmed') {
      res.json({
        paid: true,
        message: '¡El pago de la fianza ha sido verificado con éxito! La cita está confirmada y asegurada.'
      });
    } else {
      res.json({
        paid: false,
        message: `El pago de la fianza para la cita del ${latestApp.date_time.split('T')[0]} aún no se ha completado. Por favor, asegúrese de abrir el enlace de Stripe y finalizar el pago en su móvil.`
      });
    }
  } catch (err: any) {
    console.error('Error en /verify-payment:', err);
    res.status(500).json({ error: 'Error interno al verificar el pago', details: err.message });
  }
});

/**
 * Endpoint para que Retell AI cancele una cita.
 */
router.post('/cancel-appointment', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('Webhook recibido para cancel-appointment:', JSON.stringify(req.body));
    
    const args = req.body.args || req.body || {};
    const { date, email, phone, time } = args;

    if (!date || !phone) {
      res.status(400).json({ error: 'La fecha y el teléfono son obligatorios para cancelar una cita.' });
      return;
    }

    // Normalizar email si se proporciona
    let normalizedEmail = '';
    if (email) {
      normalizedEmail = email.trim().toLowerCase();
      if (normalizedEmail.includes('joyrenfe') || normalizedEmail.includes('yoirenfe') || normalizedEmail.includes('yo y renfe') || normalizedEmail.includes('yoy renfe')) {
        normalizedEmail = 'yoyrenfe@gmail.com';
      }
      if (normalizedEmail.includes('ruedasenbici') || normalizedEmail.includes('ruedas en bici') || normalizedEmail.includes('ruedasenbicicleta') || normalizedEmail.includes('ruedas en bicicleta') || normalizedEmail.includes('ruedaenbici')) {
        normalizedEmail = 'ruedasenbici@gmail.com';
      }
    }

    // Resolver teléfono
    const resolvedPhone = resolvePhoneNumber(phone, req.body);

    const tenantId = await resolveTenantId(req);
    const tenantDetails = await getTenantDetailsForWebhook(tenantId);

    if (!tenantDetails.google_refresh_token) {
      res.json({
        status: 'success',
        message: 'No se puede cancelar la cita porque el administrador aún no ha conectado su cuenta de Google Calendar.'
      });
      return;
    }

    // Buscar cita en Supabase para ese tenant que empiece en la fecha indicada
    const startRange = `${date}T00:00:00.000Z`;
    const endRange = `${date}T23:59:59.999Z`;

    // Descargar todas las citas del día para ese tenant
    const { data: allApps, error: fetchErr } = await supabase
      .from('appointments')
      .select('*')
      .eq('tenant_id', tenantId)
      .gte('date_time', startRange)
      .lte('date_time', endRange);

    if (fetchErr) {
      throw fetchErr;
    }

    // Comparar de forma flexible limpiando prefijos (últimos 9 dígitos)
    const cleanSearchPhone = resolvedPhone.replace(/\D/g, '').slice(-9);
    const cleanSearchEmail = normalizedEmail ? normalizedEmail.trim().toLowerCase() : '';

    let matchedApp = (allApps || []).find(app => {
      const cleanAppPhone = (app.patient_phone || '').replace(/\D/g, '').slice(-9);
      const phoneMatches = cleanAppPhone && cleanSearchPhone && cleanAppPhone === cleanSearchPhone;
      const emailMatches = cleanSearchEmail && app.patient_email && app.patient_email.trim().toLowerCase() === cleanSearchEmail;
      
      if (!phoneMatches && !emailMatches) return false;
      
      if (time && time.trim() !== '') {
        const appTime = new Date(app.date_time).toLocaleTimeString('es-ES', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Europe/Madrid'
        });
        return appTime === time.trim();
      }
      return true;
    });

    // BÚSQUEDA HÍBRIDA EN CALIENTE EN GOOGLE CALENDAR
    if (!matchedApp) {
      console.log(`[Cancel-Appointment] Cita no encontrada en Supabase. Consultando Google Calendar directamente...`);
      try {
        const { getCalendarClient } = require('../services/googleCalendar');
        const calendar = await getCalendarClient(tenantDetails.google_refresh_token);
        const response = await calendar.events.list({
          calendarId: 'primary',
          timeMin: startRange,
          timeMax: endRange,
          singleEvents: true
        });
        const events = response.data.items || [];
        
        const matchedEvent = events.find((evt: any) => {
          const summary = (evt.summary || '').toLowerCase();
          const description = (evt.description || '').toLowerCase();
          
          const hasPhone = summary.includes(cleanSearchPhone) || description.includes(cleanSearchPhone);
          const hasEmail = cleanSearchEmail && (summary.includes(cleanSearchEmail) || description.includes(cleanSearchEmail));
          
          if (!hasPhone && !hasEmail) return false;
          
          if (time && time.trim() !== '') {
            const eventStart = new Date(evt.start.dateTime).toLocaleTimeString('es-ES', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
              timeZone: 'Europe/Madrid'
            });
            return eventStart === time.trim();
          }
          return true;
        });

        if (matchedEvent) {
          console.log(`[Cancel-Appointment] Cita manual/externa encontrada en Google Calendar: "${matchedEvent.summary}"`);
          matchedApp = {
            id: 'temp-calendar-event',
            tenant_id: tenantId,
            patient_name: matchedEvent.summary || 'Cliente',
            patient_phone: resolvedPhone,
            patient_email: normalizedEmail,
            date_time: matchedEvent.start.dateTime,
            google_event_id: matchedEvent.id,
            google_calendar_id: 'primary',
            specialty: 'Servicio'
          };
        }
      } catch (calErr: any) {
        console.warn('[Cancel-Appointment] Error al buscar en Google Calendar en caliente:', calErr.message || calErr);
      }
    }

    if (!matchedApp) {
      console.warn(`No se encontró ninguna cita para cancelar el ${date}${time ? ' a las ' + time : ''} con teléfono ${resolvedPhone} o email ${normalizedEmail}.`);
      res.json({
        status: 'error',
        message: `No he encontrado ninguna cita programada a su nombre para el día ${date}${time ? ' a las ' + time : ''}. Por favor, confirme si la fecha y hora son correctas o facilíteme otros datos de contacto.`
      });
      return;
    }

    // Tomar la coincidencia encontrada
    const appToCancel = matchedApp;

    // 1. Eliminar de Google Calendar si tiene evento
    if (appToCancel.google_event_id) {
      console.log(`Eliminando evento de Google Calendar: ${appToCancel.google_event_id}`);
      try {
        await deleteAppointment(
          tenantDetails.google_refresh_token,
          appToCancel.google_event_id,
          appToCancel.google_calendar_id || 'primary'
        );
      } catch (calErr: any) {
        console.warn(`[Google Calendar] Advertencia al eliminar evento (procediendo igualmente con base de datos):`, calErr.message || calErr);
      }
    }

    // 2. Eliminar de Supabase (solo si existía en la DB local)
    if (appToCancel.id !== 'temp-calendar-event') {
      const { error: deleteErr } = await supabase
        .from('appointments')
        .delete()
        .eq('id', appToCancel.id);

      if (deleteErr) {
        throw deleteErr;
      }
    }

    console.log(`✅ Cita del ${date} para ${appToCancel.patient_name} cancelada correctamente.`);

    // Disparar integración de n8n
    sendToN8N('appointment_cancelled', tenantId, {
      ...appToCancel,
      status: 'cancelled'
    }).catch(err =>
      console.error('[n8n Integration Error] Fallo al enviar al webhook de n8n:', err)
    );

    // Enviar confirmación por WhatsApp (si está habilitado)
    if (tenantDetails.client_whatsapp_enabled !== false && tenantDetails.whatsapp_immediate_notification_enabled !== false) {
      const msg = `Cancelación de Cita ❌\n\nHola ${appToCancel.patient_name}, le confirmamos que su cita en ${tenantDetails.business_name} para el día ${date} ha sido cancelada correctamente.\n\nSentimos las molestias y esperamos verle en otra ocasión.`;
      sendWhatsAppMessage(resolvedPhone, msg, tenantId).catch(err => console.error('Error al enviar WhatsApp de cancelación:', err));
    }

    res.json({
      status: 'success',
      message: 'He cancelado su cita correctamente. Ya no tiene ninguna reserva para ese día. ¿Puedo ayudarle en algo más?'
    });

  } catch (error: any) {
    console.error('Error en /cancel-appointment:', error);
    res.status(500).json({
      error: 'Error al cancelar la cita',
      details: error.message
    });
  }
});

/**
 * Endpoint para que Retell AI modifique/reprograme una cita.
 */
router.post('/reschedule-appointment', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('Webhook recibido para reschedule-appointment:', JSON.stringify(req.body));
    
    const args = req.body.args || req.body || {};
    const { original_date, new_date, new_time, email, phone, original_time } = args;

    if (!original_date || !new_date || !new_time || !phone) {
      res.status(400).json({ error: 'Los parámetros original_date, new_date, new_time y phone son obligatorios.' });
      return;
    }

    // Normalizar email si se proporciona
    let normalizedEmail = '';
    if (email) {
      normalizedEmail = email.trim().toLowerCase();
      if (normalizedEmail.includes('joyrenfe') || normalizedEmail.includes('yoirenfe') || normalizedEmail.includes('yo y renfe') || normalizedEmail.includes('yoy renfe')) {
        normalizedEmail = 'yoyrenfe@gmail.com';
      }
      if (normalizedEmail.includes('ruedasenbici') || normalizedEmail.includes('ruedas en bici') || normalizedEmail.includes('ruedasenbicicleta') || normalizedEmail.includes('ruedas en bicicleta') || normalizedEmail.includes('ruedaenbici')) {
        normalizedEmail = 'ruedasenbici@gmail.com';
      }
    }

    // Resolver teléfono
    const resolvedPhone = resolvePhoneNumber(phone, req.body);

    const tenantId = await resolveTenantId(req);
    const tenantDetails = await getTenantDetailsForWebhook(tenantId);

    // Verificar si la hora está bloqueada
    const { data: dbBlockedHours } = await supabase
      .from('blocked_hours')
      .select('*')
      .eq('tenant_id', tenantId);

    const blockedRules = dbBlockedHours || [];
    if (isSlotBlocked(new_time, new_date, blockedRules)) {
      res.json({
        status: 'success',
        message: `El horario de las ${new_time} para el ${new_date} está bloqueado por el administrador. Por favor, sugiere otro horario al paciente.`
      });
      return;
    }

    if (!tenantDetails.google_refresh_token) {
      res.json({
        status: 'success',
        message: 'No se puede reprogramar la cita porque el administrador aún no ha conectado su cuenta de Google Calendar.'
      });
      return;
    }

    // 1. Buscar la cita original
    const startRange = `${original_date}T00:00:00.000Z`;
    const endRange = `${original_date}T23:59:59.999Z`;

    // Descargar todas las citas del día para ese tenant
    const { data: allApps, error: fetchErr } = await supabase
      .from('appointments')
      .select('*')
      .eq('tenant_id', tenantId)
      .gte('date_time', startRange)
      .lte('date_time', endRange);

    if (fetchErr) {
      throw fetchErr;
    }

    // Comparar de forma flexible limpiando prefijos (últimos 9 dígitos)
    const cleanSearchPhone = resolvedPhone.replace(/\D/g, '').slice(-9);
    const cleanSearchEmail = normalizedEmail ? normalizedEmail.trim().toLowerCase() : '';

    let matchedApp = (allApps || []).find(app => {
      const cleanAppPhone = (app.patient_phone || '').replace(/\D/g, '').slice(-9);
      const phoneMatches = cleanAppPhone && cleanSearchPhone && cleanAppPhone === cleanSearchPhone;
      const emailMatches = cleanSearchEmail && app.patient_email && app.patient_email.trim().toLowerCase() === cleanSearchEmail;
      
      if (!phoneMatches && !emailMatches) return false;
      
      if (original_time && original_time.trim() !== '') {
        const appTime = new Date(app.date_time).toLocaleTimeString('es-ES', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Europe/Madrid'
        });
        return appTime === original_time.trim();
      }
      return true;
    });

    // BÚSQUEDA HÍBRIDA EN CALIENTE EN GOOGLE CALENDAR
    if (!matchedApp) {
      console.log(`[Reschedule-Appointment] Cita no encontrada en Supabase. Consultando Google Calendar directamente...`);
      try {
        const { getCalendarClient } = require('../services/googleCalendar');
        const calendar = await getCalendarClient(tenantDetails.google_refresh_token);
        const response = await calendar.events.list({
          calendarId: 'primary',
          timeMin: startRange,
          timeMax: endRange,
          singleEvents: true
        });
        const events = response.data.items || [];
        
        const matchedEvent = events.find((evt: any) => {
          const summary = (evt.summary || '').toLowerCase();
          const description = (evt.description || '').toLowerCase();
          
          const hasPhone = summary.includes(cleanSearchPhone) || description.includes(cleanSearchPhone);
          const hasEmail = cleanSearchEmail && (summary.includes(cleanSearchEmail) || description.includes(cleanSearchEmail));
          
          if (!hasPhone && !hasEmail) return false;
          
          if (original_time && original_time.trim() !== '') {
            const eventStart = new Date(evt.start.dateTime).toLocaleTimeString('es-ES', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
              timeZone: 'Europe/Madrid'
            });
            return eventStart === original_time.trim();
          }
          return true;
        });

        if (matchedEvent) {
          console.log(`[Reschedule-Appointment] Cita manual/externa encontrada en Google Calendar: "${matchedEvent.summary}"`);
          matchedApp = {
            id: 'temp-calendar-event',
            tenant_id: tenantId,
            patient_name: matchedEvent.summary || 'Cliente',
            patient_phone: resolvedPhone,
            patient_email: normalizedEmail,
            date_time: matchedEvent.start.dateTime,
            google_event_id: matchedEvent.id,
            google_calendar_id: 'primary',
            specialty: 'Servicio'
          };
        }
      } catch (calErr: any) {
        console.warn('[Reschedule-Appointment] Error al buscar en Google Calendar en caliente:', calErr.message || calErr);
      }
    }

    if (!matchedApp) {
      res.json({
        status: 'error',
        message: `No he podido encontrar ninguna cita a su nombre programada para el ${original_date}${original_time ? ' a las ' + original_time : ''}. Por favor, confirme los datos.`
      });
      return;
    }

    const appToReschedule = matchedApp;

    const isPeluqueria = tenantDetails.business_sector === 'peluqueria' || 
                         (tenantDetails.business_name && (
                           tenantDetails.business_name.toLowerCase().includes('peluquería') || 
                           tenantDetails.business_name.toLowerCase().includes('peluqueria') || 
                           tenantDetails.business_name.toLowerCase().includes('barber')
                         ));
    const slotDurationMin = isPeluqueria ? 15 : 30;
    let workingHoursObj = tenantDetails.working_hours;
    if (typeof workingHoursObj === 'string') {
      try { workingHoursObj = JSON.parse(workingHoursObj); } catch (e) {}
    }
    const applyBreakRule = tenantId === '62d1ed82-287c-4329-941b-50b578c15b14' || !!workingHoursObj?.apply_break_rule;

    // 2. Comprobar disponibilidad para el nuevo hueco
    const freeSlots = await listFreeSlots(
      tenantDetails.google_refresh_token,
      new_date,
      tenantDetails.working_hours,
      appToReschedule.google_calendar_id || 'primary',
      slotDurationMin,
      applyBreakRule,
      !!tenantDetails.agenda_optimization_enabled || !!workingHoursObj?.agenda_optimization_enabled
    );

    const durationMinutes = calculateDuration(appToReschedule.specialty, tenantId);
    const numBlocksNeeded = Math.ceil(durationMinutes / slotDurationMin);

    const neededSlots: string[] = [];
    const [startHour, startMin] = new_time.split(':').map(Number);
    let currentSlotTime = new Date(`1970-01-01T${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00Z`);

    for (let i = 0; i < numBlocksNeeded; i++) {
      const timeStr = currentSlotTime.toISOString().substring(11, 16);
      neededSlots.push(timeStr);
      currentSlotTime.setUTCMinutes(currentSlotTime.getUTCMinutes() + slotDurationMin);
    }

    const allSlotsFree = neededSlots.every(slot => freeSlots.includes(slot));
    if (!allSlotsFree) {
      res.json({
        status: 'success',
        message: `Lo siento, el horario de las ${new_time} para el ${new_date} no tiene suficiente espacio disponible de forma continua (${durationMinutes} minutos). Los horarios libres para ese día son: ${freeSlots.join(', ')}.`
      });
      return;
    }

    // 3. Modificar en Google Calendar si tiene evento
    let newDateTime = new Date(`${new_date}T${new_time}:00`).toISOString();
    if (appToReschedule.google_event_id) {
      try {
        const updatedEvent = await updateAppointment(
          tenantDetails.google_refresh_token,
          appToReschedule.google_event_id,
          new_date,
          new_time,
          appToReschedule.patient_name,
          appToReschedule.patient_email,
          appToReschedule.patient_phone,
          appToReschedule.specialty,
          appToReschedule.google_calendar_id || 'primary',
          tenantDetails.business_name,
          tenantDetails.business_sector,
          durationMinutes
        );
        if (updatedEvent && updatedEvent.start?.dateTime) {
          newDateTime = updatedEvent.start.dateTime;
        }
      } catch (calErr: any) {
        console.warn(`[Google Calendar] Advertencia al actualizar evento (procediendo igualmente con base de datos):`, calErr.message || calErr);
      }
    }

    // 4. Modificar en Supabase (solo si existía en la DB local)
    let finalApp = { ...appToReschedule, date_time: newDateTime };
    if (appToReschedule.id !== 'temp-calendar-event') {
      const { data: dbApp, error: updateErr } = await supabase
        .from('appointments')
        .update({ date_time: newDateTime })
        .eq('id', appToReschedule.id)
        .select()
        .single();

      if (updateErr) {
        throw updateErr;
      }
      if (dbApp) {
        finalApp = dbApp;
      }
    }

    console.log(`✅ Cita reprogramada con éxito al ${new_date} a las ${new_time}.`);

    // Disparar integración de n8n
    sendToN8N('appointment_rescheduled', tenantId, finalApp).catch(err =>
      console.error('[n8n Integration Error] Fallo al enviar al webhook de n8n:', err)
    );

    // Enviar confirmación por WhatsApp (si está habilitado)
    if (tenantDetails.client_whatsapp_enabled !== false && tenantDetails.whatsapp_immediate_notification_enabled !== false) {
      const msg = `Modificación de Cita 🔄\n\nHola ${appToReschedule.patient_name}, le confirmamos que su cita en ${tenantDetails.business_name} ha sido modificada con éxito.\n\n🔹 Servicio: ${appToReschedule.specialty}\n🔹 Nueva Fecha: ${new_date}\n🔹 Nueva Hora: ${new_time}\n\n¡Le esperamos!`;
      sendWhatsAppMessage(resolvedPhone, msg, tenantId).catch(err => console.error('Error al enviar WhatsApp de reprogramación:', err));
    }

    res.json({
      status: 'success',
      message: `Perfecto. He reprogramado su cita para el ${new_date} a las ${new_time}. Recibirá un WhatsApp con la confirmación de la actualización. ¿Desea realizar alguna otra consulta?`
    });

  } catch (error: any) {
    console.error('Error en /reschedule-appointment:', error);
    res.status(500).json({
      error: 'Error al reprogramar la cita',
      details: error.message
    });
  }
});

// Objeto global en memoria para serializar eventos concurrentes del mismo call_id y evitar race conditions
const callMutexes: { [callId: string]: Promise<void> } = {};

/**
 * Endpoint para recibir eventos de Retell AI (Call logs & analytics).
 */
router.post('/agent-events', async (req: Request, res: Response): Promise<void> => {
  console.log('Webhook de evento de agente recibido:', JSON.stringify(req.body));
  
  // Guardar log de depuración en la base de datos Supabase
  try {
    await supabase.from('settings').upsert({
      key: 'webhook_debug_last_log',
      value: JSON.stringify({
        timestamp: new Date().toISOString(),
        body: req.body,
        headers: req.headers
      })
    }, { onConflict: 'key' });
  } catch (dbErr: any) {
    console.error('Error al guardar log de depuración en settings:', dbErr.message);
  }

  const { event, call } = req.body || {};
  
  if (event === 'call_analyzed' || event === 'call_ended') {
    const callId = call?.call_id;
    
    if (callId) {
      // Esperar a que se libere cualquier bloqueo previo para este callId
      while (callMutexes[callId]) {
        await callMutexes[callId];
      }
      
      // Establecer el nuevo bloqueo
      let resolveLock: () => void = () => {};
      callMutexes[callId] = new Promise<void>(resolve => {
        resolveLock = resolve;
      });
      
      try {
        const retellAgentId = call?.agent_id;
        const direction = call?.direction || 'inbound';
        const callerPhone = direction === 'outbound'
          ? (call?.to_number || 'Desconocido')
          : (call?.user_phone_number || call?.from_number || 'Desconocido');
        const durationSeconds = call?.duration_ms ? Math.round(call.duration_ms / 1000) : 0;
        const recordingUrl = call?.recording_url || null;
        const transcript = call?.transcript || '';
        const summary = call?.call_analysis?.call_summary || '';
        
        // Asignar etiqueta de intención en base al resumen y éxito
        let intentTag = 'Consulta General';
        if (call?.call_analysis?.custom_analysis_data?.book_success || summary.toLowerCase().includes('cita agendada') || summary.toLowerCase().includes('reserva') || summary.toLowerCase().includes('agendó')) {
          intentTag = 'Cita Agendada';
        } else if (summary.toLowerCase().includes('reclamación') || summary.toLowerCase().includes('queja') || summary.toLowerCase().includes('molesto')) {
          intentTag = 'Queja';
        } else if (durationSeconds < 10) {
          intentTag = 'Llamada Perdida';
        }

        // Buscar inquilino por retell_agent_id
        const { data: tenant, error: tErr } = await supabase
          .from('tenants')
          .select('id, text_back_enabled, text_back_message, phone_number')
          .eq('retell_agent_id', retellAgentId)
          .maybeSingle();

        if (tenant) {
          // Evitar duplicados usando un identificador único en caller_phone
          let existingLog = null;
          const phoneWithCallId = callId ? `${callerPhone}|retell:${callId}` : callerPhone;
          
          if (callId) {
            const { data: logByPhone } = await supabase
              .from('call_logs')
              .select('id, recording_url, transcript, summary')
              .eq('tenant_id', tenant.id)
              .eq('caller_phone', phoneWithCallId)
              .maybeSingle();
              
            if (logByPhone) {
              existingLog = logByPhone;
            }
          }
          
          if (!existingLog && recordingUrl) {
            const { data: logByUrl } = await supabase
              .from('call_logs')
              .select('id, recording_url, transcript, summary')
              .eq('tenant_id', tenant.id)
              .eq('recording_url', recordingUrl)
              .maybeSingle();
              
            if (logByUrl) {
              existingLog = logByUrl;
            }
          }

          let finalLog = null;

          if (existingLog) {
            console.log(`[Webhook] Registro de llamada existente detectado (ID: ${existingLog.id}). Actualizando con datos más recientes...`);
            const { data: dbLog } = await supabase
              .from('call_logs')
              .update({
                call_duration: durationSeconds,
                recording_url: recordingUrl || existingLog.recording_url,
                transcript: transcript || existingLog.transcript,
                summary: summary || existingLog.summary,
                intent_tag: intentTag
              })
              .eq('id', existingLog.id)
              .select()
              .single();
            finalLog = dbLog;
          } else {
            const { data: dbLog } = await supabase
              .from('call_logs')
              .insert({
                tenant_id: tenant.id,
                caller_phone: phoneWithCallId,
                call_duration: durationSeconds,
                recording_url: recordingUrl,
                transcript,
                summary,
                intent_tag: intentTag
              })
              .select()
              .single();
            finalLog = dbLog;
            console.log(`✅ Registro de llamada guardado para el cliente: ${tenant.id}`);
          }

          if (finalLog) {
            sendToN8N('call_ended', tenant.id, finalLog).catch(err =>
              console.error('[n8n Integration Error] Fallo al enviar llamada finalizada a n8n:', err)
            );
          }

          // Guardar el recuerdo en caller_memories para la memoria de la IA de 7 días
          if (summary && callerPhone && callerPhone !== 'Desconocido') {
            const cleanPhone = String(callerPhone).split('|')[0].trim();
            try {
              const { data: existingMemory } = await supabase
                .from('caller_memories')
                .select('id')
                .eq('tenant_id', tenant.id)
                .eq('phone_number', cleanPhone)
                .eq('summary', summary)
                .limit(1)
                .maybeSingle();

              if (!existingMemory) {
                await supabase
                  .from('caller_memories')
                  .insert({
                    tenant_id: tenant.id,
                    phone_number: cleanPhone,
                    summary: summary
                  });
                console.log(`🧠 Recuerdo de conversación guardado para ${cleanPhone}`);
              }
            } catch (memErr: any) {
              console.error('[Webhook] Error al guardar recuerdo en caller_memories:', memErr.message);
            }
          }

          // Sincronizar estado de recipiente de campaña saliente (Fase 3)
          if (callId) {
            const { data: recipient } = await supabase
              .from('outbound_campaign_recipients')
              .select('id, status')
              .eq('call_id', callId)
              .maybeSingle();

            if (recipient) {
              let newStatus = 'completed';
              if (intentTag === 'Cita Agendada') {
                newStatus = 'completed_with_booking';
              } else if (durationSeconds < 10) {
                newStatus = 'no_answer';
              }
              await supabase
                .from('outbound_campaign_recipients')
                .update({ status: newStatus })
                .eq('id', recipient.id);
              console.log(`[Campaign Webhook] Recipiente actualizado a ${newStatus} para llamada ${callId}`);
            }
          }

          // Procesar facturación por uso de minutos (Metered Billing) en segundo plano
          processMeteredBillingForCall(tenant.id, durationSeconds).catch(billErr => {
            console.error(`[Metered Billing Error] Error al facturar minutos para ${tenant.id}:`, billErr.message);
          });

          // Recuperación de llamada perdida (Missed Call Text-Back)
          if (event === 'call_analyzed' && tenant.text_back_enabled && intentTag !== 'Cita Agendada') {
            const cleanPhone = callerPhone.split('|')[0].trim();
            if (cleanPhone && cleanPhone !== 'Desconocido' && cleanPhone.length > 5) {
              const msg = tenant.text_back_message || 'Hola! Vimos que nos llamaste pero no pudimos responder. ¿Te gustaría agendar una cita de forma rápida por este chat?';
              console.log(`[Text-Back] Enviando mensaje de recuperación a ${cleanPhone} para tenant ${tenant.id}...`);
              sendWhatsAppMessage(cleanPhone, msg, tenant.id)
                .then(sent => console.log(`[Text-Back] WhatsApp enviado con éxito: ${sent}`))
                .catch(err => console.error(`[Text-Back Error] Error al enviar mensaje:`, err.message));
            }
          }

          // Alerta de Queja / Insatisfacción (Fase 2)
          if (event === 'call_analyzed') {
            const hasQueja = intentTag === 'Queja';
            const transcriptLower = transcript.toLowerCase();
            const keywords = ['queja', 'reclamación', 'reclamacion', 'insatisfecho', 'enfadado', 'molesto', 'mal servicio', 'hoja de reclamaciones', 'decepcionado', 'fatal', 'peor', 'estafa', 'engaño'];
            const hasKeywords = keywords.some(kw => transcriptLower.includes(kw));

            if ((hasQueja || hasKeywords) && tenant.phone_number) {
              const cleanCallerPhone = callerPhone.split('|')[0].trim();
              console.log(`[Sentiment Alert] Detectada posible queja de ${cleanCallerPhone}. Enviando alerta al administrador...`);
              
              const alertMsg = `⚠️ ALERTA DE INSATISFACCIÓN EN LLAMADA ⚠️\n\nHola, hemos detectado una posible queja o cliente molesto en una conversación reciente:\n\n🔹 Cliente: ${cleanCallerPhone}\n🔹 Resumen de la llamada: ${summary || 'Sin resumen disponible.'}\n\n📞 Puedes llamarle de vuelta pinchando aquí:\n👉 https://wa.me/${cleanCallerPhone.replace(/\+/g, '')} o tel:${cleanCallerPhone}`;
              
              sendWhatsAppMessage(tenant.phone_number, alertMsg, tenant.id)
                .then(sent => console.log(`[Sentiment Alert] WhatsApp de alerta enviado al admin ${tenant.phone_number}: ${sent}`))
                .catch(err => console.error(`[Sentiment Alert Error] Error al enviar alerta:`, err.message));
            }
          }
        } else {
          console.warn(`⚠️ No se encontró inquilino con retell_agent_id: ${retellAgentId}`);
        }
      } catch (err: any) {
        console.error('Error al registrar logs de llamada:', err.message);
      } finally {
        // Liberar el bloqueo
        delete callMutexes[callId];
        resolveLock();
      }
    }
  }
  res.json({ status: 'ok' });
});

function extractCallerPhone(payload: any): string {
  const data = payload?.data || {};
  const metadata = data.metadata || {};
  const variables = data.variables || {};

  const possibleFields = [
    metadata.system__caller_id,
    metadata.caller_id,
    metadata.phone_number,
    metadata.from,
    variables.system__caller_id,
    variables.caller_id
  ];

  for (const field of possibleFields) {
    if (field && typeof field === 'string' && field.trim().length > 0) {
      return field.trim();
    }
  }

  return 'Desconocido';
}

router.post('/elevenlabs-events', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('Webhook de evento de ElevenLabs recibido:', JSON.stringify(req.body));
    const { type, data } = req.body;

    if (type === 'post_call_transcription') {
      const conversationId = data?.conversation_id;
      const agentId = data?.agent_id;

      if (!conversationId || !agentId) {
        res.json({ status: 'ignored', message: 'Falta conversation_id o agent_id' });
        return;
      }

      // Evitar duplicados
      const { data: existingLog } = await supabase
        .from('call_logs')
        .select('id')
        .eq('call_id', conversationId)
        .maybeSingle();

      if (existingLog) {
        console.log(`[ElevenLabs Webhook] Registro de llamada existente detectado (ID: ${existingLog.id}). Ignorando duplicado.`);
        res.json({ status: 'ignored', message: 'Duplicado' });
        return;
      }

      // Buscar inquilino por agent_id (guardado en retell_agent_id)
      const { data: tenant } = await supabase
        .from('tenants')
        .select('id, text_back_enabled, text_back_message, phone_number')
        .eq('retell_agent_id', agentId)
        .maybeSingle();

      if (!tenant) {
        console.warn(`[ElevenLabs Webhook] No se encontró inquilino para agent_id: ${agentId}`);
        res.json({ status: 'ignored', message: 'Inquilino no encontrado' });
        return;
      }

      const callerPhone = extractCallerPhone(req.body);
      const durationSeconds = data?.metadata?.call_duration_secs || 0;
      const summary = data?.analysis?.transcript_summary || data?.transcript_summary || '';

      // Dar formato al array del transcript
      let transcriptText = '';
      if (Array.isArray(data?.transcript)) {
        transcriptText = data.transcript.map((t: any) => {
          const role = t.role === 'agent' ? 'Agente' : 'Usuario';
          return `${role}: ${t.message}`;
        }).join('\n');
      }

      // Asignar etiqueta de intención en base al resumen y éxito
      let intentTag = 'Consulta General';
      const summaryLower = summary.toLowerCase();
      if (summaryLower.includes('cita agendada') || summaryLower.includes('reserva') || summaryLower.includes('agendó')) {
        intentTag = 'Cita Agendada';
      } else if (summaryLower.includes('reclamación') || summaryLower.includes('queja') || summaryLower.includes('molesto') || summaryLower.includes('insatisfecho')) {
        intentTag = 'Queja';
      } else if (durationSeconds < 10) {
        intentTag = 'Llamada Perdida';
      }

      // Generar link de proxy local para audio
      const host = req.get('host') || '';
      const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
      const recordingUrl = `${protocol}://${host}/api/conversations/${conversationId}/audio`;

      // Insertar registro
      const { error: insErr } = await supabase
        .from('call_logs')
        .insert({
          tenant_id: tenant.id,
          caller_phone: callerPhone,
          call_duration: durationSeconds,
          recording_url: recordingUrl,
          transcript: transcriptText,
          summary: summary,
          intent_tag: intentTag,
          call_id: conversationId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (insErr) {
        throw insErr;
      }

      console.log(`[ElevenLabs Webhook] Llamada ${conversationId} registrada exitosamente para inquilino ${tenant.id}.`);

      // Alertas de insatisfacción
      const hasQueja = intentTag === 'Queja';
      const transcriptLower = transcriptText.toLowerCase();
      const keywords = ['queja', 'reclamación', 'reclamacion', 'insatisfecho', 'enfadado', 'molesto', 'mal servicio', 'hoja de reclamaciones', 'decepcionado', 'fatal', 'peor', 'estafa', 'engaño'];
      const hasKeywords = keywords.some(kw => transcriptLower.includes(kw));

      if ((hasQueja || hasKeywords) && tenant.phone_number) {
        const cleanCallerPhone = callerPhone.split('|')[0].trim();
        console.log(`[ElevenLabs Sentiment Alert] Detectada posible queja de ${cleanCallerPhone}. Enviando alerta al administrador...`);
        const alertMsg = `⚠️ ALERTA DE INSATISFACCIÓN EN LLAMADA (ElevenLabs) ⚠️\n\nHola, hemos detectado una posible queja o cliente molesto en una conversación de voz:\n\n🔹 Cliente: ${cleanCallerPhone}\n🔹 Resumen de la llamada: ${summary || 'Sin resumen disponible.'}\n\n📞 Puedes llamarle de vuelta pinchando aquí:\n👉 https://wa.me/${cleanCallerPhone.replace(/\+/g, '')} o tel:${cleanCallerPhone}`;
        
        sendWhatsAppMessage(tenant.phone_number, alertMsg, tenant.id)
          .then(sent => console.log(`[Sentiment Alert] WhatsApp de alerta enviado al admin ${tenant.phone_number}: ${sent}`))
          .catch(err => console.error(`[Sentiment Alert Error] Error al enviar alerta:`, err.message));
      }
    }
    
    res.json({ status: 'ok' });
  } catch (err: any) {
    console.error('Error en /elevenlabs-events:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Webhook para que ElevenLabs consulte el número de teléfono virtual de un negocio por su nombre.
 */
router.post('/get-business-phone', async (req: Request, res: Response): Promise<void> => {
  const businessNameInput = req.body.business_name || req.body.args?.business_name || '';
  console.log(`[Webhook get-business-phone] Buscando teléfono para: "${businessNameInput}"`);

  if (!businessNameInput || typeof businessNameInput !== 'string' || businessNameInput.trim() === '') {
    res.json({ error: 'El nombre del negocio no fue especificado.' });
    return;
  }

  try {
    const cleanSearch = businessNameInput.trim().toLowerCase();

    // Consultar todos los tenants para hacer una comparación de texto flexible (fuzzy/includes)
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('id, business_name, phone_number');

    if (error || !tenants) {
      throw new Error(error?.message || 'No se pudieron consultar los inquilinos.');
    }

    // Buscar coincidencia flexible
    const matchedTenant = tenants.find(t => {
      const name = (t.business_name || '').toLowerCase();
      // Comparación bidireccional de subcadena
      return name.includes(cleanSearch) || cleanSearch.includes(name);
    });

    if (!matchedTenant) {
      console.warn(`[Webhook get-business-phone] No se encontró coincidencia para: "${businessNameInput}"`);
      res.json({ error: 'Negocio no encontrado o no tiene demostración disponible.' });
      return;
    }

    // Buscar su teléfono virtual asignado en virtual_phones
    const { data: vpData } = await supabase
      .from('virtual_phones')
      .select('phone_number')
      .eq('tenant_id', matchedTenant.id)
      .maybeSingle();

    const finalPhone = vpData?.phone_number || matchedTenant.phone_number;

    if (!finalPhone) {
      console.warn(`[Webhook get-business-phone] El negocio "${matchedTenant.business_name}" no tiene teléfono configurado.`);
      res.json({ error: 'El negocio no tiene un número de teléfono configurado para demostraciones.' });
      return;
    }

    console.log(`[Webhook get-business-phone] Coincidencia encontrada: "${matchedTenant.business_name}" -> Teléfono: ${finalPhone}`);
    res.json({ phone_number: finalPhone, business_name: matchedTenant.business_name });
  } catch (err: any) {
    console.error('Error en /get-business-phone:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Webhook de callback para Vapi.ai (reporte de fin de llamada)
router.post('/vapi-callback', async (req: Request, res: Response) => {
  const message = req.body.message;
  console.log(`[Vapi Webhook] Recibido evento de tipo: ${message?.type}`);

  if (message?.type === 'end-of-call-report') {
    const call = message.call;
    const callId = call?.id;
    const assistantId = call?.assistantId;
    const callerPhone = call?.customer?.number || 'Desconocido';
    const recordingUrl = call?.recordingUrl;
    const summary = call?.analysis?.summary || call?.summary || '';
    const transcript = call?.transcript || '';
    const durationSeconds = Math.round(Number(call?.duration || 0));

    console.log(`[Vapi Callback] Procesando llamada finalizada: CallID: ${callId} | AssistantID: ${assistantId} | Teléfono: ${callerPhone} | Duración: ${durationSeconds}s`);

    try {
      // Buscar el inquilino (tenant) usando el retell_agent_id (donde guardamos el Vapi Assistant ID)
      const { data: tenant, error: tErr } = await supabase
        .from('tenants')
        .select('id, text_back_enabled, text_back_message, phone_number')
        .eq('retell_agent_id', assistantId)
        .maybeSingle();

      if (!tenant) {
        console.warn(`[Vapi Callback] No se encontró ningún inquilino con Vapi Assistant ID: ${assistantId}`);
        res.status(200).json({ status: 'ignored', message: 'No tenant matched Assistant ID' });
        return;
      }

      // Determinar la intención
      let intentTag = 'Consulta General';
      if (summary.toLowerCase().includes('cita agendada') || summary.toLowerCase().includes('reserva') || summary.toLowerCase().includes('agendó') || summary.toLowerCase().includes('cita creada')) {
        intentTag = 'Cita Agendada';
      } else if (summary.toLowerCase().includes('reclamación') || summary.toLowerCase().includes('queja') || summary.toLowerCase().includes('molesto')) {
        intentTag = 'Queja';
      } else if (durationSeconds < 10) {
        intentTag = 'Llamada Perdida';
      }

      // Identificador único de llamada para evitar duplicados en la base de datos
      const phoneWithCallId = callId ? `${callerPhone}|vapi:${callId}` : callerPhone;

      console.log(`[Vapi Callback] Guardando registro de llamada en Supabase para el tenant: ${tenant.id}`);

      const { data: dbLog, error: insertError } = await supabase
        .from('call_logs')
        .insert({
          tenant_id: tenant.id,
          caller_phone: phoneWithCallId,
          call_duration: durationSeconds,
          recording_url: recordingUrl,
          transcript,
          summary,
          intent_tag: intentTag
        })
        .select()
        .single();

      if (insertError) {
        console.error('[Vapi Callback] Error al guardar en call_logs:', insertError.message);
      } else if (dbLog) {
        console.log(`✅ Registro de llamada guardado con ID: ${dbLog.id}`);

        // Disparar la automatización de n8n
        sendToN8N('call_ended', tenant.id, dbLog).catch(err =>
          console.error('[Vapi Callback n8n Error] Fallo al notificar llamada finalizada a n8n:', err)
        );

        // Guardar el recuerdo en caller_memories para la memoria conversacional persistente
        if (summary && callerPhone && callerPhone !== 'Desconocido') {
          const cleanPhone = String(callerPhone).trim();
          const { error: memErr } = await supabase
            .from('caller_memories')
            .upsert({
              tenant_id: tenant.id,
              caller_phone: cleanPhone,
              memory_text: `El cliente llamó el ${new Date().toLocaleDateString('es-ES')}. Resumen: ${summary}`,
              updated_at: new Date().toISOString()
            }, {
              onConflict: 'tenant_id,caller_phone'
            });

          if (memErr) {
            console.error('[Vapi Callback Memory Error] Error al guardar memoria del cliente:', memErr.message);
          } else {
            console.log(`✅ Memoria persistente guardada con éxito para el teléfono: ${cleanPhone}`);
          }
        }
      }
    } catch (err: any) {
      console.error('[Vapi Callback Error] Fallo general de procesamiento:', err.message);
    }
  }

  res.status(200).json({ status: 'ok' });
});

export default router;
