import axios from 'axios';
import { supabase, getSettingVal } from './supabase';
import { compileSystemPrompt, resolveAgentName } from './retell';
import { listFreeSlots, deleteAppointment, updateAppointment } from './googleCalendar';
import { processBookingFlow, calculateDuration } from './booking-flow';

// Cache local en memoria para evitar llamadas redundantes a la base de datos de inquilinos por cada mensaje
const tenantCache: { [id: string]: { data: any; timestamp: number } } = {};
const CACHE_TTL_MS = 60 * 1000; // 1 minuto de cache

async function getCachedTenant(tenantId: string) {
  const now = Date.now();
  if (tenantCache[tenantId] && (now - tenantCache[tenantId].timestamp) < CACHE_TTL_MS) {
    return tenantCache[tenantId].data;
  }

  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();

  if (error || !data) {
    throw new Error(`Inquilino no encontrado o inactivo: ${error?.message || 'Sin datos'}`);
  }

  let workingHoursObj = data.working_hours;
  if (typeof workingHoursObj === 'string') {
    try { workingHoursObj = JSON.parse(workingHoursObj); } catch (e) {}
  }
  const tenantDetails = { ...data, working_hours: workingHoursObj };
  tenantCache[tenantId] = { data: tenantDetails, timestamp: now };
  return tenantDetails;
}

/**
 * Módulo del motor del Chatbot basado en Gemini 2.5 Flash
 */
export async function processChatbotMessage(
  tenantId: string,
  sessionId: string,
  messageText: string,
  originUrl: string
): Promise<string> {
  const apiKey = await getSettingVal('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no configurado.');
  }

  // 1. Obtener detalles del inquilino
  const tenant = await getCachedTenant(tenantId);

  // 2. Guardar mensaje de usuario en base de datos
  await supabase
    .from('chat_messages')
    .insert({
      tenant_id: tenantId,
      session_id: sessionId,
      sender: 'user',
      content: messageText
    });

  // 3. Cargar historial de chat (últimos 20 mensajes)
  const { data: dbMessages } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(20);

  // 4. Compilar instrucciones del sistema adaptadas a chat de texto
  const agentName = resolveAgentName(tenant.voice_id);
  const baseSystemPrompt = compileSystemPrompt(tenant);
  const textChatAddition = `
# INSTRUCCIONES ESPECÍFICAS DE TEXTO (CRÍTICO)
- Estás atendiendo al cliente a través de un CHAT DE TEXTO (como WhatsApp o un chat widget de web).
- ¡NUNCA menciones coletillas de voz como "le atiende...", "esta llamada puede ser grabada..." o despedidas telefónicas como "cuelgo la llamada"!.
- Sé sumamente claro, estructurado, educado y mantén tus mensajes breves (máximo 2 a 3 líneas o párrafos cortos) usando un lenguaje ameno y fluido.
- Puedes usar saltos de línea y emojis de forma moderada para estructurar la información (por ejemplo, para listar huecos disponibles).
- Si necesitas que realice un pago de fianza para reservar, explícale de forma muy clara que debe pinchar en el enlace enviado y esperar a que realices la confirmación.
`;
  const systemPrompt = baseSystemPrompt + textChatAddition;

  // 5. Mapear historial de chat a formato Gemini contents
  const contents: any[] = [];
  if (dbMessages && dbMessages.length > 0) {
    dbMessages.forEach((msg) => {
      // Ignorar el último mensaje de usuario ya que lo procesaremos con el flujo actual
      if (msg.content === messageText && msg.sender === 'user' && msg === dbMessages[dbMessages.length - 1]) {
        return;
      }
      contents.push({
        role: msg.sender === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
      });
    });
  }

  // Añadir mensaje de usuario actual al final
  contents.push({
    role: 'user',
    parts: [{ text: messageText }]
  });

  // 6. Declaración de herramientas del calendario
  const tools = [
    {
      function_declarations: [
        {
          name: 'consultar_disponibilidad',
          description: 'Consulta los horarios de cita disponibles en la agenda para una fecha específica (YYYY-MM-DD). Devuelve las horas libres en formato HH:MM.',
          parameters: {
            type: 'OBJECT',
            properties: {
              date: {
                type: 'STRING',
                description: 'La fecha para la cual se consulta disponibilidad en formato YYYY-MM-DD.'
              },
              specialty: {
                type: 'STRING',
                description: 'El servicio, especialidad o descripción del servicio solicitado.'
              },
              professional: {
                type: 'STRING',
                description: 'El nombre del profesional médico o estilista (opcional).'
              }
            },
            required: ['date']
          }
        },
        {
          name: 'crear_cita',
          description: 'Reserva una nueva cita en el calendario. Devuelve si se agendó directamente o si se requiere pago de fianza.',
          parameters: {
            type: 'OBJECT',
            properties: {
              date: {
                type: 'STRING',
                description: 'La fecha de la cita en formato YYYY-MM-DD.'
              },
              time: {
                type: 'STRING',
                description: 'La hora de la cita en formato HH:MM (ej. 09:30).'
              },
              name: {
                type: 'STRING',
                description: 'Nombre y apellidos completos del paciente/cliente.'
              },
              phone: {
                type: 'STRING',
                description: 'Número de teléfono de contacto (facilita el mismo número del chat si no se indica otro).'
              },
              email: {
                type: 'STRING',
                description: 'Correo electrónico del paciente/cliente (opcional).'
              },
              specialty: {
                type: 'STRING',
                description: 'Servicio o especialidad solicitada.'
              },
              professional: {
                type: 'STRING',
                description: 'El nombre del profesional seleccionado (opcional).'
              }
            },
            required: ['date', 'time', 'name', 'phone', 'specialty']
          }
        },
        {
          name: 'cancelar_cita',
          description: 'Cancela y elimina una cita existente del calendario.',
          parameters: {
            type: 'OBJECT',
            properties: {
              date: {
                type: 'STRING',
                description: 'La fecha de la cita a cancelar en formato YYYY-MM-DD.'
              },
              phone: {
                type: 'STRING',
                description: 'El número de teléfono asociado a la cita.'
              },
              email: {
                type: 'STRING',
                description: 'El correo electrónico del cliente (opcional).'
              }
            },
            required: ['date', 'phone']
          }
        },
        {
          name: 'reprogramar_cita',
          description: 'Modifica o reprograma la fecha y hora de una cita existente a una nueva ranura.',
          parameters: {
            type: 'OBJECT',
            properties: {
              original_date: {
                type: 'STRING',
                description: 'La fecha original de la cita en formato YYYY-MM-DD.'
              },
              new_date: {
                type: 'STRING',
                description: 'La nueva fecha deseada en formato YYYY-MM-DD.'
              },
              new_time: {
                type: 'STRING',
                description: 'La nueva hora deseada en formato HH:MM.'
              },
              phone: {
                type: 'STRING',
                description: 'El número de teléfono del cliente.'
              },
              email: {
                type: 'STRING',
                description: 'El correo electrónico del cliente (opcional).'
              }
            },
            required: ['original_date', 'new_date', 'new_time', 'phone']
          }
        }
      ]
    }
  ];

  // 7. Bucle de ejecución del chatbot con herramientas
  const modelUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  let loopCount = 0;
  const maxLoops = 5;

  while (loopCount < maxLoops) {
    loopCount++;

    const payload = {
      contents,
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      tools
    };

    console.log(`[Chatbot LLM] Enviando petición a Gemini (Loop ${loopCount})...`);
    const res = await axios.post(modelUrl, payload);
    const candidate = res.data.candidates?.[0];
    const modelContent = candidate?.content;
    const modelParts = modelContent?.parts || [];
    
    // Buscar si hay alguna llamada a función
    const functionCallPart = modelParts.find((p: any) => p.functionCall);

    if (functionCallPart) {
      const { name: funcName, args: funcArgs } = functionCallPart.functionCall;
      console.log(`[Chatbot LLM] 🛠️ El modelo solicita ejecutar función: ${funcName} con argumentos:`, funcArgs);

      // Añadir la solicitud del modelo a la lista de mensajes (requerido por la API de Gemini antes del resultado)
      contents.push(modelContent);

      let resultObj: any = {};

      try {
        if (!tenant.google_refresh_token) {
          resultObj = {
            error: 'Google Calendar no conectado. Indica al administrador que vincule su cuenta desde la pestaña de inicio de Receptia.'
          };
        } else {
          // Resolver las herramientas localmente
          switch (funcName) {
            case 'consultar_disponibilidad': {
              const calendarId = 'primary'; // Fallback a primary por simplicidad
              const isPeluqueria = tenant.business_sector === 'peluqueria' || 
                                   (tenant.business_name && (
                                     tenant.business_name.toLowerCase().includes('peluquería') || 
                                     tenant.business_name.toLowerCase().includes('peluqueria') || 
                                     tenant.business_name.toLowerCase().includes('barber')
                                   ));
              const slotDurationMin = isPeluqueria ? 15 : 30;
              const applyBreakRule = tenant.id === '62d1ed82-287c-4329-941b-50b578c15b14';

              const freeSlots = await listFreeSlots(
                tenant.google_refresh_token,
                funcArgs.date,
                tenant.working_hours,
                calendarId,
                slotDurationMin,
                applyBreakRule,
                !!tenant.agenda_optimization_enabled
              );

              resultObj = {
                status: 'success',
                available_slots: freeSlots,
                message: freeSlots.length > 0 
                  ? `Huecos libres el ${funcArgs.date}: ${freeSlots.join(', ')}`
                  : `No hay disponibilidad suficiente para el día ${funcArgs.date}.`
              };
              break;
            }

            case 'crear_cita': {
              // Si no se pasa el teléfono, usar el sessionId (teléfono de WhatsApp) como fallback
              const phoneArg = funcArgs.phone || sessionId;
              const bookingArgs = { ...funcArgs, phone: phoneArg };
              
              // Ejecutar flujo de reserva (gestiona fianzas Stripe y recordatorios WhatsApp automáticamente)
              const bookingResult = await processBookingFlow(
                tenantId,
                tenant,
                bookingArgs,
                originUrl,
                sessionId
              );

              resultObj = bookingResult;
              break;
            }

            case 'cancelar_cita': {
              const startRange = `${funcArgs.date}T00:00:00.000Z`;
              const endRange = `${funcArgs.date}T23:59:59.999Z`;

              // Buscar cita en Supabase para obtener el google_event_id
              const { data: appointments } = await supabase
                .from('appointments')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('patient_phone', funcArgs.phone)
                .gte('date_time', startRange)
                .lte('date_time', endRange);

              if (!appointments || appointments.length === 0) {
                resultObj = {
                  status: 'error',
                  message: `No se encontró ninguna cita para el día ${funcArgs.date} vinculada al teléfono ${funcArgs.phone}.`
                };
              } else {
                const appToCancel = appointments[0];
                if (appToCancel.google_event_id) {
                  await deleteAppointment(
                    tenant.google_refresh_token,
                    appToCancel.google_event_id,
                    appToCancel.google_calendar_id || 'primary'
                  );
                }
                
                await supabase
                  .from('appointments')
                  .delete()
                  .eq('id', appToCancel.id);

                resultObj = {
                  status: 'success',
                  message: `Cita de ${appToCancel.patient_name} el día ${funcArgs.date} cancelada correctamente.`
                };
              }
              break;
            }

            case 'reprogramar_cita': {
              const startRange = `${funcArgs.original_date}T00:00:00.000Z`;
              const endRange = `${funcArgs.original_date}T23:59:59.999Z`;

              const { data: appointments } = await supabase
                .from('appointments')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('patient_phone', funcArgs.phone)
                .gte('date_time', startRange)
                .lte('date_time', endRange);

              if (!appointments || appointments.length === 0) {
                resultObj = {
                  status: 'error',
                  message: `No se encontró ninguna cita original para el día ${funcArgs.original_date}.`
                };
              } else {
                const appToMove = appointments[0];
                const durationMinutes = calculateDuration(appToMove.specialty, tenantId);

                await updateAppointment(
                  tenant.google_refresh_token,
                  appToMove.google_event_id,
                  funcArgs.new_date,
                  funcArgs.new_time,
                  appToMove.patient_name,
                  appToMove.patient_email,
                  appToMove.patient_phone,
                  appToMove.specialty,
                  appToMove.google_calendar_id || 'primary',
                  tenant.business_name,
                  tenant.business_sector,
                  durationMinutes
                );

                const newDateTime = new Date(`${funcArgs.new_date}T${funcArgs.new_time}:00`).toISOString();
                await supabase
                  .from('appointments')
                  .update({ date_time: newDateTime })
                  .eq('id', appToMove.id);

                resultObj = {
                  status: 'success',
                  message: `Cita reprogramada con éxito al día ${funcArgs.new_date} a las ${funcArgs.new_time}.`
                };
              }
              break;
            }

            default:
              resultObj = { error: `Función desconocida: ${funcName}` };
          }
        }
      } catch (err: any) {
        console.error(`[Chatbot Tool Error] Error en función ${funcName}:`, err.message);
        resultObj = { error: err.message || 'Error en ejecución de herramienta.' };
      }

      console.log(`[Chatbot LLM] Resultado de función ${funcName} enviado al modelo:`, resultObj);

      // Añadir la respuesta de la función a la lista de mensajes
      contents.push({
        role: 'function',
        parts: [
          {
            function_response: {
              name: funcName,
              response: resultObj
            }
          }
        ]
      });

    } else {
      // Si no hay más llamadas a función, hemos llegado a la respuesta textual final
      const textResponse = modelParts.map((p: any) => p.text || '').join('\n').trim();

      // Guardar respuesta de la IA en base de datos
      await supabase
        .from('chat_messages')
        .insert({
          tenant_id: tenantId,
          session_id: sessionId,
          sender: 'ai',
          content: textResponse
        });

      return textResponse;
    }
  }

  throw new Error('Se superó el número máximo de bucles de ejecución de herramientas del chatbot.');
}
