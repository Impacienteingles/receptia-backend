import { Router, Request, Response } from 'express';
import { listFreeSlots, bookAppointment, deleteAppointment, updateAppointment } from '../services/googleCalendar';
import { supabase } from '../services/supabase';
import { sendWhatsAppMessage } from '../services/whatsapp';
import { processMeteredBillingForCall } from '../services/stripe';

const router = Router();

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
  
  if ((text.includes('tres') || text.includes('3')) && text.includes('niño') && text.includes('caballero')) {
    return 60;
  }
  if ((text.includes('dos') || text.includes('2')) && text.includes('niño') && text.includes('caballero')) {
    return 45;
  }
  if ((text.includes('un') || text.includes('1')) && text.includes('niño') && text.includes('caballero')) {
    return 30;
  }
  if (text.includes('corte') || text.includes('pelo') || text.includes('caballero') || text.includes('niño')) {
    return 15;
  }
  
  return 15; // Por defecto para esta peluquería (1 bloque = 15 min)
}

/**
 * Endpoint para que Retell AI consulte los huecos libres.
 * Se espera que el LLM llame a esta función pasando la fecha (YYYY-MM-DD).
 */
router.post('/get-availability', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('Webhook recibido para get-availability:', JSON.stringify(req.body));
    
    // Retell AI pasa los argumentos en req.body.args
    const args = req.body.args || {};
    const date = args.date;
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
    if (tenantDetails.enable_multi_professional && clientEnableMulti && tenantDetails.professionals && Array.isArray(tenantDetails.professionals)) {
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
    const applyBreakRule = tenantId === '62d1ed82-287c-4329-941b-50b578c15b14';

    console.log(`Buscando disponibilidad para la fecha: ${date} (Tenant: ${tenantId}) (Calendario: ${calendarId}) (Slot: ${slotDurationMin}m) (BreakRule: ${applyBreakRule})`);
    const freeSlots = await listFreeSlots(
      tenantDetails.google_refresh_token,
      date,
      tenantDetails.working_hours,
      calendarId,
      slotDurationMin,
      applyBreakRule
    );
    // Filtrar huecos libres según la duración requerida de la especialidad
    let filteredSlots = freeSlots;
    const specialty = args.specialty || '';
    const durationMinutes = calculateDuration(specialty, tenantId);
    const numBlocksNeeded = Math.ceil(durationMinutes / slotDurationMin);

    if (numBlocksNeeded > 1 && freeSlots.length > 0) {
      const resultSlots: string[] = [];
      for (let i = 0; i < freeSlots.length; i++) {
        const currentSlot = freeSlots[i];
        let consecutiveFound = true;
        const [hour, min] = currentSlot.split(':').map(Number);
        const nextTime = new Date(`1970-01-01T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`);

        for (let b = 1; b < numBlocksNeeded; b++) {
          nextTime.setUTCMinutes(nextTime.getUTCMinutes() + slotDurationMin);
          const nextTimeStr = nextTime.toISOString().substring(11, 16);
          if (!freeSlots.includes(nextTimeStr)) {
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
    res.json({
      status: 'success',
      available_slots: filteredSlots,
      message: filteredSlots.length > 0 
        ? `Los siguientes huecos están libres: ${filteredSlots.join(', ')}`
        : 'No hay huecos disponibles suficientes para esa duración en esta fecha. Sugiere al paciente otra fecha.'
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
 * Resuelve el nombre humano del asistente virtual en base a su voice_id para usarlo en el calendario.
 */
function resolveAgentName(voiceId: string): string {
  if (!voiceId) return 'Elena';
  const id = voiceId.toLowerCase();
  if (id.includes('manuel')) return 'Manuel';
  if (id.includes('alejandro')) return 'Alejandro';
  if (id.includes('sarah')) return 'Sarah';
  if (id.includes('daniel')) return 'Daniel';
  if (id.includes('hailey') || id.includes('elena')) return 'Elena';
  if (id.includes('eryldjeaddain9sdjamx') || id.includes('gabriela')) return 'Gabriela';
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
 * Endpoint para que Retell AI reserve una cita.
 */
router.post('/book-appointment', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('Webhook recibido para book-appointment:', JSON.stringify(req.body));
    
    const args = req.body.args || {};
    const { date, time, name, email, phone, specialty, professional } = args;

    if (!date || !time || !name || !phone || !specialty) {
      res.status(400).json({ 
        error: 'Todos los campos son requeridos: date, time, name, phone, specialty.' 
      });
      return;
    }

    // Normalizar email si se proporciona para corregir errores de transcripción fonética
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

    // Resolver número de teléfono real si la IA indica que llama desde el mismo número
    const resolvedPhone = resolvePhoneNumber(phone, req.body);

    // Resolver tenant_id y su refresh token
    const tenantId = await resolveTenantId(req);
    const tenantDetails = await getTenantDetailsForWebhook(tenantId);

    if (!tenantDetails.google_refresh_token) {
      console.warn(`[book-appointment] El inquilino ${tenantId} no tiene Google Calendar conectado.`);
      res.json({
        status: 'success',
        message: 'Lo siento, no se pudo agendar la cita porque el administrador de este negocio aún no ha conectado su cuenta de Google Calendar. Por favor, indícale amablemente al usuario que debe ir a la pestaña Inicio de su panel de control y conectar Google Calendar para poder agendar citas.'
      });
      return;
    }

    // Mapear al profesional correcto si está activo
    let calendarId = 'primary';
    let matchedProfName = null;
    const clientEnableMulti = tenantDetails.working_hours?.client_enable_multi_professional !== false;
    if (tenantDetails.enable_multi_professional && clientEnableMulti && tenantDetails.professionals && Array.isArray(tenantDetails.professionals)) {
      const profName = professional || args.professional;
      if (profName) {
        const prof = tenantDetails.professionals.find((p: any) => 
          p.name.toLowerCase().includes(String(profName).toLowerCase()) ||
          String(profName).toLowerCase().includes(p.name.toLowerCase())
        );
        if (prof) {
          calendarId = prof.calendar_id;
          matchedProfName = prof.name;
          console.log(`[Multi-Professional] Reservando en calendario: ${prof.name} (${prof.calendar_id})`);
        } else {
          console.warn(`[Multi-Professional] Profesional no encontrado al reservar: ${profName}, usando primary`);
        }
      }
    }

    const agentName = resolveAgentName(tenantDetails.voice_id);

    const isPeluqueria = tenantDetails.business_sector === 'peluqueria' || 
                         (tenantDetails.business_name && (
                           tenantDetails.business_name.toLowerCase().includes('peluquería') || 
                           tenantDetails.business_name.toLowerCase().includes('peluqueria') || 
                           tenantDetails.business_name.toLowerCase().includes('barber')
                         ));
    const slotDurationMin = isPeluqueria ? 15 : 30;
    const applyBreakRule = tenantId === '62d1ed82-287c-4329-941b-50b578c15b14';

    // 1. Obtener la disponibilidad en tiempo real
    const freeSlots = await listFreeSlots(
      tenantDetails.google_refresh_token,
      date,
      tenantDetails.working_hours,
      calendarId,
      slotDurationMin,
      applyBreakRule
    );

    // 2. Calcular cuántos bloques consume este servicio
    const durationMinutes = calculateDuration(specialty, tenantId);
    const numBlocksNeeded = Math.ceil(durationMinutes / slotDurationMin);

    // 3. Generar la secuencia de horas que deben estar libres
    const neededSlots: string[] = [];
    const [startHour, startMin] = time.split(':').map(Number);
    let currentSlotTime = new Date(`1970-01-01T${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00Z`);

    for (let i = 0; i < numBlocksNeeded; i++) {
      const timeStr = currentSlotTime.toISOString().substring(11, 16);
      neededSlots.push(timeStr);
      currentSlotTime.setUTCMinutes(currentSlotTime.getUTCMinutes() + slotDurationMin);
    }

    console.log(`[book-appointment] Cita requiere ${durationMinutes} minutos (${numBlocksNeeded} bloques). Ranuras requeridas: ${neededSlots.join(', ')}`);

    // 4. Verificar que TODAS las ranuras requeridas estén libres
    const allSlotsFree = neededSlots.every(slot => freeSlots.includes(slot));
    if (!allSlotsFree) {
      console.warn(`[book-appointment] Uno o más bloques requeridos no están libres: ${neededSlots.join(', ')}. Ocupados o infringiendo descansos.`);
      res.json({
        status: 'success',
        message: `El horario seleccionado de las ${time} para el ${date} ya no está disponible (está ocupado por otra cita). Por favor, infórmale amablemente al paciente que ese hueco ya está reservado por otra persona y ofrécele consultar la disponibilidad con tu herramienta correspondiente para sugerirle otra hora de forma natural.`
      });
      return;
    }

    const event = await bookAppointment(
      tenantDetails.google_refresh_token,
      date,
      time,
      name,
      normalizedEmail,
      resolvedPhone,
      specialty,
      calendarId,
      agentName,
      tenantDetails.business_name,
      tenantDetails.business_sector,
      durationMinutes
    );

    console.log('Cita agendada correctamente:', event.htmlLink);
    
    // Opcionalmente podemos registrar la cita en la tabla `appointments` de Supabase para que el médico la vea en su panel
    try {
      console.log('Registrando cita en base de datos Supabase...');
      const status = 'confirmed';
      
      await supabase
        .from('appointments')
        .insert({
          tenant_id: tenantId,
          patient_name: name,
          patient_phone: resolvedPhone,
          patient_email: normalizedEmail,
          date_time: event.start?.dateTime || new Date(`${date}T${time}:00`).toISOString(),
          specialty: specialty,
          status: status,
          google_event_id: event.id,
          google_calendar_id: calendarId,
          professional_name: matchedProfName
        });
      console.log(`✅ Cita registrada en Supabase exitosamente con estado: ${status}`);

      // Envío de confirmación por WhatsApp (si está habilitado)
      if (tenantDetails.client_whatsapp_enabled !== false && tenantDetails.whatsapp_immediate_notification_enabled !== false) {
        const msg = `Confirmación de Cita 📅\n\nHola ${name}, le confirmamos su cita en ${tenantDetails.business_name}.\n\n🔹 Servicio: ${specialty}\n🔹 Fecha: ${date}\n🔹 Hora: ${time}\n\n¡Le esperamos!`;
        sendWhatsAppMessage(resolvedPhone, msg, tenantId).catch(err => console.error('Error al enviar WhatsApp de confirmación:', err));
      }
    } catch (dbErr: any) {
      console.warn('⚠️ No se pudo registrar la cita en la tabla appointments de Supabase:', dbErr.message);
    }

    res.json({
      status: 'success',
      message: 'Cita agendada correctamente en el calendario. (IMPORTANTE: Confirma al paciente de forma natural que su cita ha sido reservada con éxito y que recibirá una confirmación por WhatsApp. NO menciones enlaces ni digas URLs).'
    });
  } catch (error: any) {
    console.error('Error en /book-appointment:', error);
    res.status(500).json({ 
      error: 'Error interno al reservar la cita', 
      details: error.message 
    });
  }
});

/**
 * Endpoint para que Retell AI cancele una cita.
 */
router.post('/cancel-appointment', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('Webhook recibido para cancel-appointment:', JSON.stringify(req.body));
    
    const args = req.body.args || {};
    const { date, email, phone } = args;

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

    // Buscar cita en Supabase para ese tenant que coincida con el número de teléfono o email, y que empiece en la fecha indicada
    const startRange = `${date}T00:00:00.000Z`;
    const endRange = `${date}T23:59:59.999Z`;

    // Primero buscamos por teléfono
    let { data: appointments, error: fetchErr } = await supabase
      .from('appointments')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('patient_phone', resolvedPhone)
      .gte('date_time', startRange)
      .lte('date_time', endRange);

    if (fetchErr || !appointments || appointments.length === 0) {
      // Intentar buscar por email solo si se proporcionó
      if (normalizedEmail) {
        const { data: altApps, error: altErr } = await supabase
          .from('appointments')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('patient_email', normalizedEmail)
          .gte('date_time', startRange)
          .lte('date_time', endRange);
          
        if (!altErr && altApps && altApps.length > 0) {
          appointments = altApps;
        }
      }
    }

    if (!appointments || appointments.length === 0) {
      console.warn(`No se encontró ninguna cita para cancelar el ${date} con teléfono ${resolvedPhone} o email ${normalizedEmail}.`);
      res.json({
        status: 'success',
        message: 'No he encontrado ninguna cita programada a su nombre para esa fecha. Por favor, confirme si la fecha es correcta o facilíteme otros datos de contacto.'
      });
      return;
    }

    // Tomar la primera coincidencia
    const appToCancel = appointments[0];

    // 1. Eliminar de Google Calendar si tiene evento
    if (appToCancel.google_event_id) {
      console.log(`Eliminando evento de Google Calendar: ${appToCancel.google_event_id}`);
      await deleteAppointment(
        tenantDetails.google_refresh_token,
        appToCancel.google_event_id,
        appToCancel.google_calendar_id || 'primary'
      );
    }

    // 2. Eliminar de Supabase
    const { error: deleteErr } = await supabase
      .from('appointments')
      .delete()
      .eq('id', appToCancel.id);

    if (deleteErr) {
      throw deleteErr;
    }

    console.log(`✅ Cita del ${date} para ${appToCancel.patient_name} cancelada correctamente.`);

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
    
    const args = req.body.args || {};
    const { original_date, new_date, new_time, email, phone } = args;

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

    let { data: appointments, error: fetchErr } = await supabase
      .from('appointments')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('patient_phone', resolvedPhone)
      .gte('date_time', startRange)
      .lte('date_time', endRange);

    if (fetchErr || !appointments || appointments.length === 0) {
      // Intentar buscar por email solo si se proporcionó
      if (normalizedEmail) {
        const { data: altApps } = await supabase
          .from('appointments')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('patient_email', normalizedEmail)
          .gte('date_time', startRange)
          .lte('date_time', endRange);
          
        if (altApps && altApps.length > 0) {
          appointments = altApps;
        }
      }
    }

    if (!appointments || appointments.length === 0) {
      res.json({
        status: 'success',
        message: `No he podido encontrar ninguna cita a su nombre programada para el ${original_date}. Por favor, confirme los datos.`
      });
      return;
    }

    const appToReschedule = appointments[0];

    const isPeluqueria = tenantDetails.business_sector === 'peluqueria' || 
                         (tenantDetails.business_name && (
                           tenantDetails.business_name.toLowerCase().includes('peluquería') || 
                           tenantDetails.business_name.toLowerCase().includes('peluqueria') || 
                           tenantDetails.business_name.toLowerCase().includes('barber')
                         ));
    const slotDurationMin = isPeluqueria ? 15 : 30;
    const applyBreakRule = tenantId === '62d1ed82-287c-4329-941b-50b578c15b14';

    // 2. Comprobar disponibilidad para el nuevo hueco
    const freeSlots = await listFreeSlots(
      tenantDetails.google_refresh_token,
      new_date,
      tenantDetails.working_hours,
      appToReschedule.google_calendar_id || 'primary',
      slotDurationMin,
      applyBreakRule
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
    }

    // 4. Modificar en Supabase
    const { error: updateErr } = await supabase
      .from('appointments')
      .update({ date_time: newDateTime })
      .eq('id', appToReschedule.id);

    if (updateErr) {
      throw updateErr;
    }

    console.log(`✅ Cita reprogramada con éxito al ${new_date} a las ${new_time}.`);

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

/**
 * Endpoint para recibir eventos de Retell AI (Call logs & analytics).
 */
router.post('/agent-events', async (req: Request, res: Response): Promise<void> => {
  console.log('Webhook de evento de agente recibido:', JSON.stringify(req.body));
  const { event, call } = req.body;
  
  if (event === 'call_analyzed' || event === 'call_ended') {
    const retellAgentId = call?.agent_id;
    const callerPhone = call?.user_phone_number || call?.from_number || 'Desconocido';
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

    try {
      // Buscar inquilino por retell_agent_id
      const { data: tenant, error: tErr } = await supabase
        .from('tenants')
        .select('id')
        .eq('retell_agent_id', retellAgentId)
        .maybeSingle();

      if (tenant) {
        // Evitar duplicados: Buscar si ya existe una llamada registrada en los últimos 90 segundos para el mismo cliente y teléfono
        const ninetySecondsAgo = new Date(Date.now() - 90 * 1000).toISOString();
        const { data: existingLogs } = await supabase
          .from('call_logs')
          .select('id, recording_url, transcript, summary')
          .eq('tenant_id', tenant.id)
          .eq('caller_phone', callerPhone)
          .gte('created_at', ninetySecondsAgo)
          .order('created_at', { ascending: false })
          .limit(1);

        if (existingLogs && existingLogs.length > 0) {
          const lastLog = existingLogs[0];
          console.log(`[Webhook] Registro de llamada duplicado detectado (ID: ${lastLog.id}). Actualizando con datos más recientes...`);
          
          await supabase
            .from('call_logs')
            .update({
              call_duration: durationSeconds,
              recording_url: recordingUrl || lastLog.recording_url,
              transcript: transcript || lastLog.transcript,
              summary: summary || lastLog.summary,
              intent_tag: intentTag
            })
            .eq('id', lastLog.id);
        } else {
          await supabase
            .from('call_logs')
            .insert({
              tenant_id: tenant.id,
              caller_phone: callerPhone,
              call_duration: durationSeconds,
              recording_url: recordingUrl,
              transcript,
              summary,
              intent_tag: intentTag
            });
          console.log(`✅ Registro de llamada guardado para el cliente: ${tenant.id}`);
        }

        // Procesar facturación por uso de minutos (Metered Billing) en segundo plano
        processMeteredBillingForCall(tenant.id, durationSeconds).catch(billErr => {
          console.error(`[Metered Billing Error] Error al facturar minutos para ${tenant.id}:`, billErr.message);
        });
      } else {
        console.warn(`⚠️ No se encontró inquilino con retell_agent_id: ${retellAgentId}`);
      }
    } catch (err: any) {
      console.error('Error al registrar logs de llamada:', err.message);
    }
  }
  res.json({ status: 'ok' });
});

export default router;
