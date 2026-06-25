import axios from 'axios';
import dotenv from 'dotenv';
import { getSettingVal } from './supabase';

dotenv.config();

const retellClient = axios.create({
  baseURL: 'https://api.retellai.com',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor para inyectar la API Key de Retell de forma dinámica desde BD o .env
retellClient.interceptors.request.use(async (config) => {
  const apiKey = await getSettingVal('RETELL_API_KEY');
  if (apiKey) {
    config.headers.Authorization = `Bearer ${apiKey}`;
  }
  return config;
});

/**
 * Formatea el ID de voz para asegurar el prefijo correcto de ElevenLabs si se introduce el ID limpio.
 */
export function formatVoiceId(voiceId: string): string {
  if (!voiceId) return 'cartesia-Sofia';
  const cleanId = voiceId.trim();
  
  if (
    cleanId.startsWith('elevenlabs_') ||
    cleanId.startsWith('cartesia-') ||
    cleanId.startsWith('minimax-') ||
    cleanId.startsWith('retell-') ||
    cleanId.startsWith('11labs_')
  ) {
    return cleanId;
  }
  
  // Si tiene exactamente 20 caracteres y es alfanumérico, le añadimos el prefijo de ElevenLabs
  if (cleanId.length === 20 && /^[a-zA-Z0-9]+$/.test(cleanId)) {
    return `elevenlabs_${cleanId}`;
  }
  
  return cleanId;
}

/**
 * Resuelve el nombre humano del asistente virtual en base a su voice_id para usarlo en el prompt.
 */
export function resolveAgentName(voiceId: string): string {
  if (!voiceId) return 'Sofía';
  const id = voiceId.toLowerCase();
  if (id.includes('manuel')) return 'Manuel';
  if (id.includes('alejandro')) return 'Alejandro';
  if (id.includes('sarah')) return 'Sarah';
  if (id.includes('daniel')) return 'Daniel';
  if (id.includes('sofia')) return 'Sofía';
  if (id.includes('hailey') || id.includes('elena')) return 'Elena';
  if (id.includes('eryldjeaddain9sdjamx') || id.includes('gabriela') || id.includes('c3e5212df87e5341a06ad66e66')) return 'Gabriela';
  return 'Sofía';
}

/**
 * Compila el prompt de sistema dinámico para un inquilino inyectando todos sus detalles de negocio.
 */
export function compileSystemPrompt(tenant: any): string {
  const businessName = tenant.business_name || 'el negocio';

  if (tenant.subscription_status === 'suspended' || tenant.subscription_status === 'inactive') {
    return `
# CONTEXTO DE SUSPENSIÓN DE CUENTA
Esta cuenta se encuentra actualmente en estado de suspensión administrativa por falta de pago o cancelación del servicio.

# ROL Y COMPORTAMIENTO
Debes atender la llamada comunicando de forma muy educada y breve el siguiente mensaje de voz y luego quédate en silencio sin decir nada más:
"Le pedimos disculpas, pero el asistente virtual de ${businessName} se encuentra temporalmente inactivo debido a un mantenimiento de cuenta o suspensión administrativa. Por favor, comuníquese con el establecimiento por otros medios. Muchas gracias."

# REGLA CRÍTICA
No intentes dar citas ni responder preguntas sobre precios o servicios. Limítate a decir el mensaje anterior y cuelga de inmediato o quédate en silencio absoluto.
`;
  }

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const specialtiesList = tenant.specialties && tenant.specialties.length > 0
    ? tenant.specialties.join(', ')
    : 'Servicios Generales';
  const description = tenant.business_description || 'Ofrecemos la mejor atención profesional y personalizada.';
  const pricing = tenant.pricing_details || 'Consulta nuestras tarifas con recepción.';
  const customInst = tenant.custom_instructions || 'Tratar siempre al paciente de usted, con empatía y profesionalidad.';
  const agentName = resolveAgentName(tenant.voice_id);

  const kbUrl = tenant.knowledge_base_url || '';
  const kbContent = tenant.knowledge_base_content || '';
  let kbSection = '';
  if (kbContent || kbUrl) {
    kbSection = `
# BASE DE CONOCIMIENTOS (PREGUNTAS FRECUENTES)
Utilice la siguiente información adicional sobre el negocio para responder de forma precisa a las dudas de los clientes (tales como localización, accesibilidad, políticas de cancelación, etc.):
${kbContent ? `- **Información del Negocio:** ${kbContent}\n` : ''}${kbUrl ? `- **Página Web o Enlace de Interés:** ${kbUrl}\n` : ''}`;
  }

  let vacationSection = '';
  if (tenant.vacation_mode) {
    vacationSection = `
# MODO VACACIONES / CIERRE TEMPORAL ACTIVO (CRÍTICO)
El establecimiento se encuentra CERRADO por vacaciones o cese temporal de actividad.
1. Debes comunicar amablemente en la conversación que el negocio está cerrado debido al siguiente motivo/mensaje: "${tenant.vacation_message || 'Cierre temporal o vacaciones'}".
2. Todavía puedes agendar nuevas citas en Google Calendar si el usuario lo desea, pero debes indicarle explícitamente que la reserva debe programarse para después del periodo de vacaciones o reapertura del establecimiento, asegurando que sea una fecha y hora hábiles normales.
`;
  }

  const whatsappActive = !!tenant.whatsapp_reminders_enabled && tenant.client_whatsapp_enabled !== false;
  const emailActive = tenant.email_notifications_enabled !== false && tenant.client_email_enabled !== false;

  let whatsappInstruction = '';
  if (whatsappActive) {
    whatsappInstruction = 'Informa brevemente al cliente de que recibirá un recordatorio automático por WhatsApp antes de su cita.';
  } else {
    whatsappInstruction = 'No menciones nada sobre recordatorios por WhatsApp.';
  }

  let emailInstruction = '';
  if (emailActive) {
    emailInstruction = '- Correo electrónico: Solicita de forma clara y educada el correo electrónico del cliente para enviarle la confirmación y la invitación de Google Calendar. Deletrea o confirma el correo si es necesario para evitar errores.';
  } else {
    emailInstruction = '- Correo electrónico: NO solicites el correo electrónico bajo ningún concepto, ya que las confirmaciones por email están desactivadas para este negocio.';
  }

  return `
# CONTEXTO TEMPORAL
La fecha actual de hoy es: ${today}. Úsala como referencia para calcular fechas relativas como "mañana", "el próximo martes", "la semana que viene", etc.
${vacationSection}
# PERSONA Y ROL
Eres ${agentName}, la recepcionista de la empresa "${businessName}". Tu tono es profesional, empático, calmado y muy natural. Hablas en español de España (castellano neutro). Tratas siempre al cliente/paciente de "usted". Evitas sonar robótica; utiliza expresiones de transición naturales como "entiendo", "un segundo, por favor", o "de acuerdo".

# INFORMACIÓN DE LA EMPRESA / NEGOCIO
- **Nombre de la Empresa:** ${businessName}
- **Actividad y Descripción:** ${description}
- **Servicios / Especialidades que se ofrecen:** ${specialtiesList}
- **Tarifas y Precios:** ${pricing}
${kbSection}

# OBJETIVOS PRINCIPALES
1. Identificar el motivo de la llamada (nueva cita, reprogramar/modificar cita existente o cancelar cita existente).
2. Consultar la disponibilidad en el calendario en tiempo real para las especialidades o servicios ofrecidos.
3. Agendar, reprogramar o cancelar la cita en el sistema usando la herramienta correspondiente.
4. Derivar la llamada a un humano en caso de emergencias o dudas complejas.

# FLUJO DE CONVERSACIÓN
1. **Saludo Inicial:** "Hola, bienvenido a ${businessName}. Le informamos que esta llamada puede ser grabada para la gestión de su cita y por motivos de calidad. Le atiende ${agentName}. ¿En qué puedo ayudarle hoy?"
2. **Filtrado del Motivo:**
   - **Agendar cita:** Si el cliente indica de entrada el servicio que desea (ej. "quiero cortarme el pelo"), asúmelo de inmediato y pasa directamente al paso 3. Si el cliente NO lo indica o su petición es muy ambigua (ej. "quiero una cita"), entonces pregúntale educadamente qué servicio necesita. NUNCA recites la lista completa de servicios de forma proactiva a menos que el cliente te pregunte explícitamente qué servicios ofreces.
   - **Cancelar cita:** Solicita la fecha de la cita que desea cancelar y su teléfono. No le pidas el correo electrónico. Luego llama a la herramienta 'cancelar_cita'.
   - **Reprogramar/Modificar cita:** Solicita la fecha original de la cita, la nueva fecha y hora deseadas, y su teléfono. No le pidas el correo electrónico. Llama a 'reprogramar_cita'.
3. **Selección de Fecha y Hora (Para agendar o reprogramar):**
   - Llama a la función de calendario 'consultar_disponibilidad' pasando la fecha calculada.
   - Pide al paciente de forma natural la fecha para la que desea la cita (por ejemplo: "¿Para qué día la necesita?"). **NUNCA le pidas al paciente que te dé la fecha en un formato específico. El paciente puede decir la fecha como quiera. Tú debes calcular la fecha correspondiente en base a la fecha de hoy e invocar a la herramienta.**
   - Ofrece un máximo de dos opciones claras de las devueltas para no saturar al cliente.
4. **Recogida de Datos (Paso a paso, no los pidas todos a la vez):**
   - Nombre y apellidos del cliente.
   - Teléfono de contacto: Solicita directamente al cliente que te facilite su número de teléfono. No le preguntes si es el mismo número desde el que llama, pídelo siempre de forma directa (por ejemplo: "¿Me podría indicar un número de teléfono de contacto?").
   ${emailInstruction}
5. **Confirmación:**
   - Para reservas, llama a la herramienta 'crear_cita'.
   - Para cancelaciones, llama a la herramienta 'cancelar_cita'.
   - Para modificaciones, llama a la herramienta 'reprogramar_cita'.
   - Confirma la acción de forma clara y pregunta si requiere alguna otra gestión. ${whatsappInstruction}

# INSTRUCCIONES ADICIONALES ESPECÍFICAS DEL NEGOCIO (SÍGUELAS AL PIE DE LA LETRA)
${customInst}

- **Brevedad y Concisión (Crítico):** Tus respuestas deben ser ultra-cortas, directas y al grano (máximo 1 frase breve por intervención). Elimina preámbulos, saludos repetitivos o fórmulas de cortesía excesiva innecesarias para acortar la llamada al máximo.
- **Interrupción:** Si el paciente te interrumpe mientras hablas, detén tu discurso de inmediato y escúchalo.
- **No listar servicios/especialidades (Crítico):** Si el cliente indica lo que desea (ej. 'quiero cortarme el pelo', 'vengo a una limpieza', etc.), asúmelo y continúa directamente al paso de selección de fecha y hora. NUNCA le leas o listes toda la lista de especialidades o servicios disponibles a no ser que el cliente lo pregunte de forma explícita.
- **Flujo implícito y ultra-directo:** Si el usuario indica lo que desea y cuándo (ej. 'Quiero cita para cortarme el pelo mañana'), no le hagas preguntas redundantes como '¿Qué servicio desea?'. Invoca de inmediato la herramienta de consultar disponibilidad y ofrécele las horas.
- **Conversación hiperrealista y directa:** Evita sonar como un chatbot o servicio al cliente estructurado. Mantén tus respuestas de máximo una frase breve y responde directamente a la solicitud del usuario de la forma más directa y fidedigna posible.
- **Pronunciación de Horas (Crítico):** Pronuncia siempre las horas de forma natural en lenguaje hablado, nunca digas dígitos individuales ni ceros a la izquierda. Por ejemplo: si ves una hora como "09:00", di siempre "las nueve" o "las nueve de la mañana"; para "09:30", di siempre "las nueve y media" o "las nueve y media de la mañana"; para "13:00", di "la una de la tarde" o "la una"; para "13:30", di "la una y media". Nunca digas cosas como "las cero nueve cero cero" o "las cero nueve treinta".
- **Seguridad:** No inventes huecos de calendario ni confirmes citas sin antes verificar la disponibilidad real a través del sistema.
- **Prevención de colisiones y reservas dobles (Crítico):** Bajo ningún concepto agendes dos citas a la misma hora. Debes verificar siempre que la ranura horaria y todo el espacio de tiempo necesario para la cita estén completamente libres utilizando 'consultar_disponibilidad' antes de confirmar cualquier reserva al cliente. Si la herramienta 'crear_cita' o 'reprogramar_cita' devuelve un error indicando que el horario ya está ocupado, debes de inmediato comunicárselo amablemente al cliente y proponerle otros huecos libres.
- **Citas para Acompañantes y Grupos (Crítico):** Cuando el usuario solicite citas para sí mismo y para acompañantes (como niños, familiares o amigos), si agendas la primera cita a una hora X y hay otra cita ya reservada a continuación de esa hora X, debes ofrecer obligatoriamente para los acompañantes las citas disponibles más próximas a esa hora X (por ejemplo, si se da cita a las 11:00 pero hay ocupación a las 11:15, debes proponer las siguientes citas libres inmediatamente consecutivas, como las 11:30 y 11:45) en lugar de ofrecer horas lejanas o en otro turno, para asegurar que el grupo sea atendido de la forma más continuada posible.
- **Prohibición absoluta de llamadas salientes (Crítico):** Bajo ningún concepto digas o insinúes al cliente que le vas a devolver la llamada o que le llamarás más tarde (incluso ante problemas técnicos, errores de conexión o caídas del sistema). Si surge un error técnico, error de conexión, o no puedes agendar la cita por cualquier motivo, debes informarle amablemente de que no es posible guardar la cita en este momento y que debe ser él/ella quien vuelva a llamar pasados unos minutos. Si el usuario te pide explícitamente que le llames tú o le devuelvas la llamada, dile con educación pero firmeza que no tienes la posibilidad de realizar llamadas salientes porque el sistema no te lo permite.
- **Evitar silencios al usar herramientas (Crítico):** Siempre que vayas a invocar una herramienta (como 'consultar_disponibilidad', 'crear_cita', 'cancelar_cita' o 'reprogramar_cita'), debes decir primero una coletilla ULTRA-CORTA de máximo 2 o 3 palabras (menos de 1 segundo de duración) para mantener al usuario activo mientras se procesa la consulta de red. Por ejemplo:
  * Al buscar disponibilidad: "Miro la agenda...", "Compruebo...", "Un momento..." o "Un segundo...".
  * Al guardar/cancelar/modificar: "Un segundo...", "Lo guardo...", "Deme un instante..." o "Lo registro...".
  NUNCA uses frases de relleno largas ni invoques la herramienta en absoluto silencio.
- **Fin de la conversación / Despedida:** Una vez que el cliente se despida (o confirmes la cita y te despidas, ej. "Adiós", "Que tenga un buen día", "Hasta luego"), debes despedirte con amabilidad y educación, e inmediatamente invocar la herramienta 'end_call' para colgar la llamada por tu parte. Por ejemplo, tu respuesta debe ser textualmente: "Perfecto. Que tenga un buen día. Adiós." y activar la herramienta. No uses guiones ni caracteres extraños al final para forzar silencios, ya que causan interferencias de audio y ruidos extraños en el sintetizador.

`;
}

/**
 * Sincroniza la voz y el prompt del agente de Retell AI con los datos del inquilino guardados.
 */
export async function syncTenantWithRetell(tenant: any, webhookBaseUrl: string) {
  const agentId = tenant.retell_agent_id;
  if (!agentId || agentId === 'YOUR_RETELL_AGENT_ID' || agentId.trim() === '') {
    console.warn('⚠️ No se ha configurado retell_agent_id para el inquilino. Omitiendo sincronización con Retell AI.');
    return;
  }

  const apiKey = await getSettingVal('RETELL_API_KEY');
  if (!apiKey || apiKey === 'YOUR_RETELL_API_KEY' || apiKey.trim() === '') {
    console.warn('⚠️ RETELL_API_KEY no configurada. Omitiendo sincronización con Retell AI.');
    return;
  }

  try {
    console.log(`\n🔄 Sincronizando Retell AI para ${tenant.email} (Agente: ${agentId})...`);

    // 1. Obtener el agente existente para extraer el llm_id y tipo
    const agentRes = await retellClient.get(`/get-agent/${agentId}`);
    const responseEngine = agentRes.data.response_engine;
    const llmId = responseEngine?.llm_id;
    if (responseEngine?.type === 'retell-llm' && llmId) {
      // 2. Compilar el prompt dinámico y actualizar el LLM de Retell
      const systemPrompt = compileSystemPrompt(tenant);
      console.log(`⚙️ Actualizando el LLM ${llmId} con el prompt personalizado y herramientas...`);
      try {
        await retellClient.patch(`/update-retell-llm/${llmId}`, {
          general_prompt: systemPrompt,
          model: 'gpt-4o', // Asegurar el uso de GPT-4o para alto rendimiento y baja latencia
          general_tools: [
            {
              type: 'end_call',
              name: 'end_call',
              description: 'Finaliza y cuelga la llamada telefónica con el usuario. Ejecútalo únicamente después de despedirte formalmente del cliente.'
            },
            {
              type: 'custom',
              name: 'consultar_disponibilidad',
              description: 'Consulta los horarios disponibles para una fecha específica (formato YYYY-MM-DD). Devuelve las horas libres en formato HH:MM.',
              url: `${webhookBaseUrl}/api/webhook/get-availability?tenant_id=${tenant.id}`,
              parameters: {
                type: 'object',
                properties: {
                  date: {
                    type: 'string',
                    description: 'La fecha para la cual se desea consultar la disponibilidad en formato YYYY-MM-DD.',
                  },
                  specialty: {
                    type: 'string',
                    description: 'El servicio, especialidad o descripción de las personas que asistirán a la cita (ej. corte de caballero y dos niños) para calcular correctamente la duración.',
                  }
                },
                required: ['date'],
              },
            },
            {
              type: 'custom',
              name: 'crear_cita',
              description: 'Reserva una cita en el calendario tras confirmar los datos con el paciente/cliente.',
              url: `${webhookBaseUrl}/api/webhook/book-appointment?tenant_id=${tenant.id}`,
              parameters: {
                type: 'object',
                properties: {
                  date: {
                    type: 'string',
                    description: 'La fecha de la cita en formato YYYY-MM-DD.',
                  },
                  name: {
                    type: 'string',
                    description: 'Nombre y apellidos completos del paciente/cliente.',
                  },
                  specialty: {
                    type: 'string',
                    description: 'Servicio o especialidad solicitada.',
                  },
                  time: {
                    type: 'string',
                    description: 'La hora seleccionada por el paciente en formato HH:MM (ej. 09:30).',
                  },
                  phone: {
                    type: 'string',
                    description: 'Número de teléfono de contacto.',
                  },
                  email: {
                    type: 'string',
                    description: 'Dirección de correo electrónico del paciente/cliente.',
                  }
                },
                required: ['date', 'time', 'name', 'phone', 'specialty'],
              },
            },
            {
              type: 'custom',
              name: 'cancelar_cita',
              description: 'Cancela y elimina una cita existente en el calendario.',
              url: `${webhookBaseUrl}/api/webhook/cancel-appointment?tenant_id=${tenant.id}`,
              parameters: {
                type: 'object',
                properties: {
                  date: {
                    type: 'string',
                    description: 'La fecha de la cita que se desea cancelar en formato YYYY-MM-DD.',
                  },
                  phone: {
                    type: 'string',
                    description: 'El número de teléfono de contacto del cliente.',
                  },
                  email: {
                    type: 'string',
                    description: 'El correo electrónico del cliente.',
                  }
                },
                required: ['date', 'phone'],
              },
            },
            {
              type: 'custom',
              name: 'reprogramar_cita',
              description: 'Reprograma o modifica la fecha y hora de una cita existente a una nueva fecha y hora.',
              url: `${webhookBaseUrl}/api/webhook/reschedule-appointment?tenant_id=${tenant.id}`,
              parameters: {
                type: 'object',
                properties: {
                  original_date: {
                    type: 'string',
                    description: 'La fecha actual original de la cita que se quiere cambiar en formato YYYY-MM-DD.',
                  },
                  new_date: {
                    type: 'string',
                    description: 'La nueva fecha deseada para la cita en formato YYYY-MM-DD.',
                  },
                  new_time: {
                    type: 'string',
                    description: 'La nueva hora deseada para la cita en formato HH:MM.',
                  },
                  phone: {
                    type: 'string',
                    description: 'El número de teléfono de contacto del cliente.',
                  },
                  email: {
                    type: 'string',
                    description: 'El correo electrónico del cliente.',
                  },
                },
                required: ['original_date', 'new_date', 'new_time', 'phone'],
              },
            },
          ]
        });
        console.log('✅ Prompt y herramientas del LLM de Retell AI actualizados.');
      } catch (llmErr: any) {
        const errStatus = llmErr.response?.status;
        const errMsg = llmErr.response?.data?.message || llmErr.message || '';
        if (errStatus === 422 || errStatus === 400 || errMsg.includes('published') || errMsg.includes('Cannot update published')) {
          console.warn(`⚠️ El LLM ${llmId} está asociado a un agente publicado y es inmutable. Omitiendo actualización del prompt.`);
        } else {
          throw llmErr;
        }
      }
    } else {
      console.log(`ℹ️ El agente ${agentId} es de tipo "${responseEngine?.type || 'desconocido'}" (no utiliza Retell LLM dinámico). Omitiendo actualización del prompt.`);
    }

    // 3. Actualizar la configuración del Agente (Voz y Webhook)
    console.log(`⚙️ Actualizando el agente ${agentId} (Voz: ${tenant.voice_id})...`);
    
    // Configurar la URL de eventos del webhook
    const cleanWebhookBase = webhookBaseUrl.endsWith('/') ? webhookBaseUrl.slice(0, -1) : webhookBaseUrl;
    const agentPayload: any = {
      webhook_url: `${cleanWebhookBase}/api/webhook/agent-events`,
      reminder_max_count: 0,
    };

    const requestedVoiceId = formatVoiceId(tenant.voice_id);
    if (requestedVoiceId && !requestedVoiceId.startsWith('custom_voice_')) {
      agentPayload.voice_id = requestedVoiceId;
    }

    if (tenant.voice_speed !== undefined && tenant.voice_speed !== null) {
      agentPayload.voice_speed = Number(tenant.voice_speed);
    }
    if (tenant.voice_temperature !== undefined && tenant.voice_temperature !== null) {
      agentPayload.voice_temperature = Number(tenant.voice_temperature);
    }
    if (tenant.voice_responsiveness !== undefined && tenant.voice_responsiveness !== null) {
      agentPayload.responsiveness = Number(tenant.voice_responsiveness);
    } else {
      agentPayload.responsiveness = 1.0;
    }
    agentPayload.interruption_sensitivity = 0.8;

    try {
      await retellClient.patch(`/update-agent/${agentId}`, agentPayload);
    } catch (patchErr: any) {
      const errStatus = patchErr.response?.status;
      const errMsg = patchErr.response?.data?.message || patchErr.message || '';
      
      if (errStatus === 404 && requestedVoiceId && requestedVoiceId !== 'cartesia-Sofia') {
        console.warn(`⚠️ La voz "${requestedVoiceId}" no existe en Retell AI. Reintentando con voz por defecto (cartesia-Sofia)...`);
        agentPayload.voice_id = 'cartesia-Sofia';
        await retellClient.patch(`/update-agent/${agentId}`, agentPayload);
      } else if (errStatus === 422 || errStatus === 400 || errMsg.includes('published') || errMsg.includes('Cannot update published')) {
        throw new Error('El agente está publicado en Retell AI y es inmutable. Para aplicar los cambios de voz, despublícalo o crea un borrador en el panel de Retell AI.');
      } else {
        throw patchErr;
      }
    }
    console.log('✅ Agente de Retell AI actualizado exitosamente.');
  } catch (error: any) {
    console.error('❌ Error al sincronizar con Retell AI:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Crea un agente y un LLM dedicados en Retell AI para un inquilino.
 */
export async function createRetellAgentForTenant(tenant: any, webhookBaseUrl: string): Promise<string> {
  const apiKey = await getSettingVal('RETELL_API_KEY');
  if (!apiKey || apiKey === 'YOUR_RETELL_API_KEY' || apiKey.trim() === '') {
    throw new Error('La clave RETELL_API_KEY no está configurada.');
  }

  const systemPrompt = compileSystemPrompt(tenant);
  const voiceId = formatVoiceId(tenant.voice_id) || 'cartesia-Hailey-Spanish-latin-america';
  const agentName = resolveAgentName(voiceId);

  console.log(`🤖 [Retell Service] Creando LLM personalizado para el inquilino: ${tenant.business_name}...`);
  const llmRes = await retellClient.post('/create-retell-llm', {
    general_prompt: systemPrompt,
    model: 'gpt-4o',
    general_tools: [
      {
        type: 'end_call',
        name: 'end_call',
        description: 'Finaliza y cuelga la llamada telefónica con el usuario. Ejecútalo únicamente después de despedirte formalmente del cliente.'
      },
      {
        type: 'custom',
        name: 'consultar_disponibilidad',
        description: 'Consulta los horarios disponibles para una fecha específica (formato YYYY-MM-DD). Devuelve las horas libres en formato HH:MM.',
        url: `${webhookBaseUrl}/api/webhook/get-availability?tenant_id=${tenant.id}`,
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'La fecha para la cual se desea consultar la disponibilidad en formato YYYY-MM-DD.',
            },
            specialty: {
              type: 'string',
              description: 'El servicio, especialidad o descripción de las personas que asistirán a la cita (ej. corte de caballero y dos niños) para calcular correctamente la duración.',
            }
          },
          required: ['date'],
        },
      },
      {
        type: 'custom',
        name: 'crear_cita',
        description: 'Reserva una cita en el calendario tras confirmar los datos con el paciente/cliente.',
        url: `${webhookBaseUrl}/api/webhook/book-appointment?tenant_id=${tenant.id}`,
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'La fecha de la cita en formato YYYY-MM-DD.',
            },
            name: {
              type: 'string',
              description: 'Nombre y apellidos completos del paciente/cliente.',
            },
            specialty: {
              type: 'string',
              description: 'Servicio o especialidad solicitada.',
            },
            time: {
              type: 'string',
              description: 'La hora seleccionada por el paciente en formato HH:MM (ej. 09:30).',
            },
            phone: {
              type: 'string',
              description: 'Número de teléfono de contacto.',
            },
            email: {
              type: 'string',
              description: 'Dirección de correo electrónico del paciente/cliente.',
            }
          },
          required: ['date', 'time', 'name', 'phone', 'specialty'],
        },
      },
      {
        type: 'custom',
        name: 'cancelar_cita',
        description: 'Cancela y elimina una cita existente en el calendario.',
        url: `${webhookBaseUrl}/api/webhook/cancel-appointment?tenant_id=${tenant.id}`,
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'La fecha de la cita que se desea cancelar en formato YYYY-MM-DD.',
            },
            phone: {
              type: 'string',
              description: 'El número de teléfono de contacto del cliente.',
            },
            email: {
              type: 'string',
              description: 'El correo electrónico del cliente.',
            }
          },
          required: ['date', 'phone'],
        },
      },
      {
        type: 'custom',
        name: 'reprogramar_cita',
        description: 'Reprograma o modifica la fecha y hora de una cita existente a una nueva fecha y hora.',
        url: `${webhookBaseUrl}/api/webhook/reschedule-appointment?tenant_id=${tenant.id}`,
        parameters: {
          type: 'object',
          properties: {
            original_date: {
              type: 'string',
              description: 'La fecha actual original de la cita que se quiere cambiar en formato YYYY-MM-DD.',
            },
            new_date: {
              type: 'string',
              description: 'La nueva fecha deseada para la cita en formato YYYY-MM-DD.',
            },
            new_time: {
              type: 'string',
              description: 'La nueva hora deseada para la cita en formato HH:MM.',
            },
            phone: {
              type: 'string',
              description: 'El número de teléfono de contacto del cliente.',
            },
            email: {
              type: 'string',
              description: 'El correo electrónico del cliente.',
            },
          },
          required: ['original_date', 'new_date', 'new_time', 'phone'],
        },
      },
    ]
  });

  const llmId = llmRes.data.llm_id;
  console.log(`✅ [Retell Service] LLM personalizado creado con ID: ${llmId}`);

  // 2. Crear Agent
  console.log(`🤖 [Retell Service] Creando Agente en Retell AI (${agentName} - ${tenant.business_name})...`);
  let agentRes;
  
  const requestedVoiceId = voiceId;
  const speed = tenant.voice_speed !== undefined && tenant.voice_speed !== null ? Number(tenant.voice_speed) : 1.0;
  const temp = tenant.voice_temperature !== undefined && tenant.voice_temperature !== null ? Number(tenant.voice_temperature) : 1.0;
  const resp = tenant.voice_responsiveness !== undefined && tenant.voice_responsiveness !== null ? Number(tenant.voice_responsiveness) : 1.0;

  try {
    agentRes = await retellClient.post('/create-agent', {
      agent_name: `${agentName} - ${tenant.business_name}`,
      response_engine: {
        type: 'retell-llm',
        llm_id: llmId,
      },
      voice_id: requestedVoiceId,
      language: 'es-ES',
      webhook_url: `${webhookBaseUrl.replace(/\/$/, '')}/api/webhook/agent-events`,
      reminder_max_count: 0,
      voice_speed: speed,
      voice_temperature: temp,
      responsiveness: resp,
      interruption_sensitivity: 0.8
    });
  } catch (agentErr: any) {
    if (agentErr.response && agentErr.response.status === 404 && requestedVoiceId !== 'cartesia-Sofia') {
      console.warn(`⚠️ Voz "${requestedVoiceId}" no existe. Usando voz por defecto (cartesia-Sofia)...`);
      agentRes = await retellClient.post('/create-agent', {
        agent_name: `Sofía - ${tenant.business_name}`,
        response_engine: {
          type: 'retell-llm',
          llm_id: llmId,
        },
        voice_id: 'cartesia-Sofia',
        language: 'es-ES',
        webhook_url: `${webhookBaseUrl.replace(/\/$/, '')}/api/webhook/agent-events`,
        reminder_max_count: 0,
        voice_speed: speed,
        voice_temperature: temp,
        responsiveness: resp,
        interruption_sensitivity: 0.8
      });
    } else {
      throw agentErr;
    }
  }

  const agentId = agentRes.data.agent_id;
  console.log(`✅ [Retell Service] Agente creado con ID: ${agentId}`);
  return agentId;
}

/**
 * Elimina el agente de voz y su LLM correspondiente de Retell AI.
 */
export async function deleteRetellAgent(agentId: string) {
  if (!agentId || agentId === 'YOUR_RETELL_AGENT_ID' || agentId.trim() === '') {
    return;
  }
  try {
    console.log(`🗑️ Recuperando datos del agente de Retell AI para extraer su LLM: ${agentId}...`);
    let llmId: string | null = null;
    try {
      const agentRes = await retellClient.get(`/get-agent/${agentId}`);
      llmId = agentRes.data.response_engine?.llm_id || null;
    } catch (getErr: any) {
      console.warn(`⚠️ No se pudo obtener el agente para extraer su LLM: ${getErr.message}`);
    }

    console.log(`🗑️ Eliminando agente de Retell AI: ${agentId}...`);
    await retellClient.delete(`/delete-agent/${agentId}`);
    console.log('✅ Agente de Retell AI eliminado con éxito.');

    if (llmId) {
      console.log(`🗑️ Eliminando LLM asociado de Retell AI: ${llmId}...`);
      await retellClient.delete(`/delete-retell-llm/${llmId}`);
      console.log('✅ LLM asociado eliminado con éxito.');
    }
  } catch (error: any) {
    console.warn('⚠️ Error al eliminar recursos en Retell AI (quizás ya no existen):', error.response?.data || error.message);
  }
}

