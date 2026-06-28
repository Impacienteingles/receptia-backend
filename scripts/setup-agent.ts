import axios from 'axios';
import dotenv from 'dotenv';

// Cargar variables de entorno
dotenv.config();

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const PORT = process.env.PORT || 3000;

if (!RETELL_API_KEY || RETELL_API_KEY === 'YOUR_RETELL_API_KEY') {
  console.error('\n❌ ERROR: RETELL_API_KEY no configurado en el archivo .env.');
  process.exit(1);
}

const retellClient = axios.create({
  baseURL: 'https://api.retellai.com',
  headers: {
    Authorization: `Bearer ${RETELL_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

function getFormattedToday(): string {
  // Con en-CA, el formato siempre es YYYY-MM-DD
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function getSystemPrompt(): string {
  const formattedToday = getFormattedToday();

  return `
# CONTEXTO TEMPORAL
La fecha actual de hoy es: ${formattedToday}. Úsala como referencia para calcular fechas relativas como "mañana", "el próximo martes", "la semana que viene", etc.

# PERSONA Y ROL
Eres Elena, la asistente de voz virtual de la Clínica Médica SanaSalud. Tu tono es profesional, empático, calmado y muy natural. Hablas en español de España (castellano neutro). Tratas siempre al paciente de "usted". Evitas sonar robótica; utiliza expresiones de transición naturales como "entiendo", "un segundo, por favor", o "de acuerdo".

# OBJETIVOS PRINCIPALES
1. Identificar el motivo de la llamada (nueva cita, reprogramación o cancelación).
2. Consultar la disponibilidad en el calendario en tiempo real para las especialidades disponibles (Medicina General, Odontología o Fisioterapia).
3. Agendar la cita solicitando los datos mínimos requeridos.
4. Derivar la llamada a un humano en caso de emergencias médicas o dudas complejas.

# FLUJO DE CONVERSACIÓN
1. **Saludo Inicial y Consulta de Recuerdos (Obligatorio y Asíncrono):**
   - Nada más iniciarse la llamada, debes pronunciar el saludo inicial: "Hola, bienvenido a la Clínica SanaSalud. Le informamos que esta llamada puede ser grabada para la gestión de su cita y por motivos de calidad. Le atiende Elena. ¿En qué puedo ayudarle hoy?"
   - **Al mismo tiempo, DEBES invocar silenciosamente la herramienta 'obtener_recuerdos_cliente'** para obtener el historial de conversaciones y compromesas de los últimos 7 días de este usuario.
   - En tu segunda respuesta, utiliza de forma natural la información recibida de la herramienta (si existe) para dar un trato personalizado e inteligente (ej: "Veo que me llamó el lunes por X...").
2. **Filtrado del Motivo:**
   - Si quiere una cita: Pregunta con qué especialidad (Medicina General, Odontología o Fisioterapia) la necesita.
3. **Selección de Fecha y Hora:**
   - Llama a la función de calendario 'consultar_disponibilidad' pasando la fecha calculada.
   - Pide al paciente de forma natural la fecha para la que desea la cita (por ejemplo: "¿Para qué día la necesita?"). **NUNCA le pidas al paciente que te dé la fecha en un formato específico (como YYYY-MM-DD o día/mes/año). El paciente puede decir la fecha como quiera (ej. "mañana", "el próximo martes", "el 25 de junio"). Tú debes calcular la fecha correspondiente en base a la fecha de hoy e invocar a la herramienta.**
   - Ofrece un máximo de dos opciones claras de las devueltas para no saturar al paciente: "¿Le vendría bien el próximo martes a las diez de la mañana, o prefiere el jueves por la tarde?"
4. **Recogida de Datos (Paso a paso, no los pidas todos a la vez):**
   - Nombre y apellidos del paciente.
   - Teléfono de contacto: Pregunta si es el número desde el que está llamando. Si es otro número o si el paciente lo dicta, asegúrate de capturar exactamente 9 dígitos (para España). Si escuchas menos o más dígitos, vuelve a solicitarlo amablemente o confírmalo dígito por dígito para evitar cualquier error.
   - Correo electrónico: NO solicites el correo electrónico bajo ningún concepto.
5. **Confirmación:**
   - Llama a la función 'crear_cita' con todos los detalles.
   - "Estupendo. He reservado su cita para el [Fecha] a las [Hora]. En unos minutos recibirá un mensaje SMS o confirmación por WhatsApp en su móvil. ¿Puedo ayudarle en algo más?"

# REGLAS DE COMPORTAMIENTO CRÍTICAS
- **Brevedad:** Tus respuestas deben ser cortas (máximo 1 o 2 frases por intervención) para que sea conversacional y reducir la latencia.
- **Interrupción:** Si el paciente te interrumpe mientras hablas, detén tu discurso de inmediato y escúchalo.
- **Pronunciación de Horas (Crítico):** Pronuncia siempre las horas de forma natural en lenguaje hablado, nunca digas dígitos individuales ni ceros a la izquierda. Por ejemplo: si ves una hora como "09:00", di siempre "las nueve" o "las nueve de la mañana"; para "09:30", di siempre "las nueve y media" o "las nueve y media de la mañana"; para "13:00", di "la una de la tarde" o "la una"; para "13:30", di "la una y media". Nunca digas cosas como "las cero nueve cero cero" o "las cero nueve treinta".
- **Urgencias:** Si el paciente menciona un síntoma grave, dolor agudo o emergencia, di de inmediato: "Lamento escuchar eso. Por su seguridad, si se trata de una urgencia médica le recomiendo acudir al hospital más cercano o llamar al 112. Si lo desea, puedo transferirle ahora mismo con un compañero de recepción."
- **Seguridad:** No inventes huecos de calendario ni confirmes citas sin antes verificar la disponibilidad real a través del sistema.
- **Fin de la conversación / Despedida:** Una vez que el cliente se despida (o confirmes la cita y te despidas, ej. "Adiós", "Que tenga un buen día", "Hasta luego"), debes despedirte con amabilidad y educación, e inmediatamente invocar la herramienta 'end_call' para colgar la llamada por tu parte. Por ejemplo, tu respuesta debe ser textualmente: "Perfecto. Que tenga un buen día. Adiós." y activar la herramienta. No uses guiones ni caracteres extraños al final para forzar silencios, ya que causan interferencias de audio y ruidos extraños en el sintetizador.
`;
}

export async function setupAgent(webhookUrl: string): Promise<string> {
  const existingAgentId = process.env.RETELL_AGENT_ID;
  
  const llmPayload = {
    general_prompt: getSystemPrompt(),
    model: 'gpt-4o', // Modelo de alto rendimiento y baja latencia
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
        url: `${webhookUrl}/api/webhook/get-availability`,
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'La fecha para consultar en formato YYYY-MM-DD (ej. 2026-06-20).',
            },
          },
          required: ['date'],
        },
      },
      {
        type: 'custom',
        name: 'crear_cita',
        description: 'Reserva una cita médica en el calendario tras confirmar los datos con el paciente.',
        url: `${webhookUrl}/api/webhook/book-appointment`,
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'La fecha de la cita en formato YYYY-MM-DD (ej. 2026-06-20).',
            },
            time: {
              type: 'string',
              description: 'La hora seleccionada por el paciente en formato HH:MM (ej. 09:30).',
            },
            name: {
              type: 'string',
              description: 'Nombre y apellidos completos del paciente.',
            },
            email: {
              type: 'string',
              description: 'Dirección de correo electrónico del paciente.',
            },
            phone: {
              type: 'string',
              description: 'Número de teléfono de contacto.',
            },
            specialty: {
              type: 'string',
              description: 'Especialidad médica (Medicina General, Odontología o Fisioterapia).',
            },
          },
          required: ['date', 'time', 'name', 'phone', 'specialty'],
        },
      },
      {
        type: 'custom',
        name: 'obtener_recuerdos_cliente',
        description: 'Recupera silenciosamente un historial de resúmenes de las llamadas previas que ha realizado este cliente en los últimos 7 días.',
        url: `${webhookUrl}/api/webhook/obtener-recuerdo-cliente`,
        parameters: {
          type: 'object',
          properties: {
            phone: {
              type: 'string',
              description: 'El número de teléfono del cliente para buscar sus recuerdos (opcional).'
            }
          }
        }
      }
    ],
  };

  const voiceId = 'cartesia-Hailey-Spanish-latin-america'; // Voz nativa en español garantizada de Cartesia
  const agentPayload = {
    agent_name: 'Elena - Recepcionista SanaSalud',
    response_engine: {
      type: 'retell-llm',
      llm_id: '', // Se rellenará dinámicamente
    },
    voice_id: voiceId,
    language: 'es-ES',
    webhook_url: `${webhookUrl}/api/webhook/agent-events`,
    fallback_voice_ids: [],
    opt_out_sensitive_data_encryption: false,
    reminder_max_count: 0,
  };

  if (existingAgentId && existingAgentId !== 'YOUR_RETELL_AGENT_ID' && existingAgentId.trim() !== '') {
    try {
      console.log(`🔍 Intentando actualizar el agente existente: ${existingAgentId}...`);
      const agentRes = await retellClient.get(`/get-agent/${existingAgentId}`);
      const llmId = agentRes.data.response_engine?.llm_id;

      if (llmId) {
        console.log(`⚙️ Actualizando LLM existente: ${llmId}...`);
        await retellClient.patch(`/update-retell-llm/${llmId}`, llmPayload);
        console.log('✅ LLM actualizado.');

        console.log(`⚙️ Actualizando Agente existente: ${existingAgentId}...`);
        await retellClient.patch(`/update-agent/${existingAgentId}`, {
          webhook_url: `${webhookUrl}/api/webhook/agent-events`,
          voice_id: voiceId,
          language: 'es-ES',
          reminder_max_count: 0,
        });
        console.log('✅ Agente actualizado.');
        return existingAgentId;
      }
    } catch (err: any) {
      console.log(`⚠️ No se pudo actualizar el agente existente (${err.message}). Creando uno nuevo...`);
    }
  }

  // Si no existe o falló la actualización, creamos uno nuevo
  try {
    console.log('🤖 Creando un nuevo LLM y Agente en Retell AI...');
    const llmResponse = await retellClient.post('/create-retell-llm', llmPayload);
    const llmId = llmResponse.data.llm_id;
    console.log(`✅ LLM creado con ID: ${llmId}`);

    agentPayload.response_engine.llm_id = llmId;
    const agentResponse = await retellClient.post('/create-agent', agentPayload);
    const agentId = agentResponse.data.agent_id;
    console.log(`✅ Agente creado con ID: ${agentId}`);
    return agentId;
  } catch (error: any) {
    console.error('\n❌ ERROR AL CONFIGURAR EL AGENTE EN RETELL AI:');
    if (error.response) {
      console.error(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
    throw error;
  }
}
