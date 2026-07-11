import { supabase } from './supabase';
import { bookAppointmentCalCom as bookAppointment, listFreeSlotsCalCom as listFreeSlots, updateAppointmentCalCom } from './calCom';
import { createNoShowDepositSession } from './stripe';
import { sendWhatsAppMessage } from './whatsapp';
import { sendToN8N } from './n8n';

/**
 * Resuelve el número de teléfono real del llamante si es un placeholder.
 */
export function resolvePhoneNumber(phone: string, fromNumber?: string): string {
  const trimmed = phone.trim();
  const lower = trimmed.toLowerCase();
  const containsLetters = /[a-zA-Z]/.test(trimmed);
  
  if (
    containsLetters ||
    lower.includes('mismo') ||
    lower.includes('llama') ||
    lower.includes('este')
  ) {
    if (fromNumber) {
      return fromNumber;
    }
    return '+34600000000';
  }
  
  return trimmed;
}

/**
 * Calcula la duración estimada de la cita.
 */
export function calculateDuration(specialty: string, tenantId: string): number {
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
  
  return 15;
}

/**
 * Resuelve el nombre del asistente virtual.
 */
export function resolveAgentName(voiceId: string): string {
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

interface BookingArgs {
  date: string;
  time: string;
  name: string;
  phone: string;
  email?: string;
  specialty: string;
  professional?: string;
  duration?: number;
}

/**
 * Procesa el flujo completo de reserva de cita (con o sin fianza de Stripe).
 */
export async function processBookingFlow(
  tenantId: string,
  tenantDetails: any,
  args: BookingArgs,
  originUrl: string,
  callerPhoneFallback?: string
) {
  const { date, time, name, email, phone, specialty, professional } = args;

  // 1. Normalizar email
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

  // 2. Resolver teléfono
  const resolvedPhone = resolvePhoneNumber(phone, callerPhoneFallback);

  // 3. Determinar calendario y profesional
  let calendarId = 'primary';
  let matchedProfName = null;
  const clientEnableMulti = tenantDetails.working_hours?.client_enable_multi_professional !== false;
  const hasMultiProfPermission = tenantDetails.plan_id && !tenantDetails.plan_id.includes('inicial');
  if (hasMultiProfPermission && tenantDetails.enable_multi_professional && clientEnableMulti && tenantDetails.professionals && Array.isArray(tenantDetails.professionals)) {
    const profName = professional;
    if (profName) {
      const prof = tenantDetails.professionals.find((p: any) => 
        p.name.toLowerCase().includes(String(profName).toLowerCase()) ||
        String(profName).toLowerCase().includes(p.name.toLowerCase())
      );
      if (prof) {
        calendarId = prof.calendar_id;
        matchedProfName = prof.name;
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
  let workingHoursObj = tenantDetails.working_hours;
  if (typeof workingHoursObj === 'string') {
    try { workingHoursObj = JSON.parse(workingHoursObj); } catch (e) {}
  }
  const applyBreakRule = tenantId === '62d1ed82-287c-4329-941b-50b578c15b14' || !!workingHoursObj?.apply_break_rule;

  // 4. Comprobar disponibilidad
  const freeSlots = await listFreeSlots(
    tenantDetails.google_refresh_token,
    date,
    tenantDetails.working_hours,
    calendarId,
    slotDurationMin,
    applyBreakRule,
    !!tenantDetails.agenda_optimization_enabled || !!workingHoursObj?.agenda_optimization_enabled
  );

  const durationMinutes = args.duration ? Number(args.duration) : calculateDuration(specialty, tenantId);
  const numBlocksNeeded = Math.ceil(durationMinutes / slotDurationMin);

  const neededSlots: string[] = [];
  const [startHour, startMin] = time.split(':').map(Number);
  let currentSlotTime = new Date(`1970-01-01T${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00Z`);

  for (let i = 0; i < numBlocksNeeded; i++) {
    const timeStr = currentSlotTime.toISOString().substring(11, 16);
    neededSlots.push(timeStr);
    currentSlotTime.setUTCMinutes(currentSlotTime.getUTCMinutes() + slotDurationMin);
  }

  const allSlotsFree = neededSlots.every(slot => freeSlots.includes(slot));
  if (!allSlotsFree) {
    return {
      status: 'busy',
      message: `El horario de las ${time} para el ${date} ya no está disponible. Huecos libres: ${freeSlots.join(', ')}.`
    };
  }

  const hasDepositPermission = tenantDetails.plan_id && !tenantDetails.plan_id.includes('inicial');
  const isDepositEnabled = hasDepositPermission && !!tenantDetails.enable_no_show_deposits;
  const depositAmount = Number(tenantDetails.no_show_deposit_amount || 10.00);

  if (isDepositEnabled) {
    console.log(`[Booking Flow] Fianza activa para ${tenantDetails.business_name}. Creando cita pendiente...`);
    
    // 5A. Agendar en Google Calendar con prefijo de pendiente
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
      durationMinutes,
      true // isPendingPayment = true
    );

    // 6A. Crear registro en Supabase con status: pending_payment
    const { data: dbApp, error: dbErr } = await supabase
      .from('appointments')
      .insert({
        tenant_id: tenantId,
        patient_name: name,
        patient_phone: resolvedPhone,
        patient_email: normalizedEmail,
        date_time: event.start?.dateTime || new Date(`${date}T${time}:00`).toISOString(),
        specialty: specialty,
        status: 'pending_payment',
        google_event_id: event.id,
        google_calendar_id: calendarId,
        professional_name: matchedProfName
      })
      .select()
      .single();

    if (dbErr || !dbApp) {
      throw new Error(`Error al registrar cita pendiente de fianza en base de datos: ${dbErr?.message}`);
    }

    // 7A. Generar enlace de Stripe Checkout
    const paymentUrl = await createNoShowDepositSession(
      tenantId,
      dbApp.id,
      depositAmount,
      resolvedPhone,
      originUrl
    );

    // 8A. Enviar enlace de pago por WhatsApp inmediatamente
    const cleanPhoneForWhatsApp = resolvedPhone.split('|')[0].trim();
    const formattedDate = new Date(dbApp.date_time).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });
    const formattedTime = new Date(dbApp.date_time).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
    
    const waMsg = `Pre-reserva de Cita 📅⏳\n\nHola ${name}, hemos reservado provisionalmente su cita en ${tenantDetails.business_name}.\n\n🔹 Servicio: ${specialty}\n🔹 Fecha: ${formattedDate}\n🔹 Hora: ${formattedTime}\n\n⚠️ Para confirmar su cita, debe abonar un depósito/fianza de ${depositAmount}€ ingresando a este enlace de pago seguro de Stripe:\n🔗 ${paymentUrl}\n\nDispone de 15 minutos para realizar el pago o la reserva se cancelará automáticamente. ¡Gracias!`;
    
    await sendWhatsAppMessage(cleanPhoneForWhatsApp, waMsg, tenantId).catch(err => 
      console.error('[Booking Flow WARNING] Error al enviar enlace de fianza por WhatsApp:', err.message)
    );

    return {
      status: 'payment_required',
      appointment_id: dbApp.id,
      payment_url: paymentUrl,
      message: `Se requiere un depósito de ${depositAmount}€. He enviado un enlace de pago de Stripe por WhatsApp al teléfono del cliente. El cliente debe completar el pago para confirmar la cita.`
    };
  } else {
    console.log(`[Booking Flow] Fianza desactivada. Buscando si el cliente ya tiene una cita confirmada previa...`);
    const cleanPhone = resolvedPhone.split('|')[0].trim();
    
    const { data: existingApp } = await supabase
      .from('appointments')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('status', 'confirmed')
      .like('patient_phone', `${cleanPhone}%`)
      .not('date_time', 'like', `${date}%`)
      .order('date_time', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingApp && existingApp.google_event_id) {
      console.log(`[Booking Flow] Detectada cita confirmada previa (${existingApp.id}, eventId: ${existingApp.google_event_id}). Iniciando reprogramación automática...`);
      
      const event = await updateAppointmentCalCom(
        tenantDetails.google_refresh_token,
        existingApp.google_event_id,
        date,
        time,
        name,
        normalizedEmail,
        resolvedPhone,
        specialty,
        calendarId,
        tenantDetails.business_name,
        tenantDetails.business_sector,
        durationMinutes
      );

      // Actualizar el registro existente en la base de datos
      const { data: updatedApp, error: dbErr } = await supabase
        .from('appointments')
        .update({
          date_time: event.start?.dateTime || new Date(`${date}T${time}:00`).toISOString(),
          specialty: specialty,
          google_event_id: event.id,
          professional_name: matchedProfName
        })
        .eq('id', existingApp.id)
        .select()
        .single();

      if (dbErr) {
        console.warn('⚠️ No se pudo actualizar la cita reprogramada en la base de datos:', dbErr.message);
      } else if (updatedApp) {
        // Disparar integración de n8n para cita reprogramada
        sendToN8N('appointment_rescheduled', tenantId, updatedApp).catch(err =>
          console.error('[n8n Integration Error] Fallo al enviar reprogramación a n8n:', err)
        );
      }

      // Enviar mensaje de WhatsApp de reprogramación
      const cleanPhoneForWhatsApp = resolvedPhone.split('|')[0].trim();
      if (tenantDetails.client_whatsapp_enabled !== false && tenantDetails.whatsapp_immediate_notification_enabled !== false) {
        const msg = `Modificación de Cita 📅🔄\n\nHola ${name}, le confirmamos que hemos modificado su cita en ${tenantDetails.business_name}.\n\n🔹 Servicio: ${specialty}\n🔹 Nueva Fecha: ${date}\n🔹 Nueva Hora: ${time}\n\n¡Le esperamos!`;
        sendWhatsAppMessage(cleanPhoneForWhatsApp, msg, tenantId).catch(err => console.error('Error al enviar WhatsApp de reprogramación:', err));
      }

      return {
        status: 'confirmed',
        message: 'Cita modificada y confirmada con éxito. Se ha notificado al cliente el cambio por WhatsApp.'
      };
    }

    console.log(`[Booking Flow] No se encontró cita previa. Creando cita confirmada desde cero...`);
    
    // 5B. Agendar en Google Calendar normalmente
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
      durationMinutes,
      false // isPendingPayment = false
    );

    // 6B. Registrar en Supabase con status: confirmed
    const { data: dbApp, error: dbErr } = await supabase
      .from('appointments')
      .insert({
        tenant_id: tenantId,
        patient_name: name,
        patient_phone: resolvedPhone,
        patient_email: normalizedEmail,
        date_time: event.start?.dateTime || new Date(`${date}T${time}:00`).toISOString(),
        specialty: specialty,
        status: 'confirmed',
        google_event_id: event.id,
        google_calendar_id: calendarId,
        professional_name: matchedProfName
      })
      .select()
      .single();

    if (dbErr) {
      console.warn('⚠️ No se pudo guardar la cita en la tabla appointments de Supabase:', dbErr.message);
    } else if (dbApp) {
      // Disparar integración de n8n
      sendToN8N('appointment_created', tenantId, dbApp).catch(err =>
        console.error('[n8n Integration Error] Fallo al enviar al webhook de n8n:', err)
      );
    }

    // 7B. Enviar mensaje de WhatsApp de confirmación directa
    const cleanPhoneForWhatsApp = resolvedPhone.split('|')[0].trim();
    if (tenantDetails.client_whatsapp_enabled !== false && tenantDetails.whatsapp_immediate_notification_enabled !== false) {
      const msg = `Confirmación de Cita 📅\n\nHola ${name}, le confirmamos su cita en ${tenantDetails.business_name}.\n\n🔹 Servicio: ${specialty}\n🔹 Fecha: ${date}\n🔹 Hora: ${time}\n\n¡Le esperamos!`;
      sendWhatsAppMessage(cleanPhoneForWhatsApp, msg, tenantId).catch(err => console.error('Error al enviar WhatsApp de confirmación:', err));
    }

    return {
      status: 'confirmed',
      message: 'Cita agendada y confirmada con éxito. Se ha notificado al cliente por WhatsApp.'
    };
  }
}
