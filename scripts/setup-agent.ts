const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const dotenv = require('dotenv');

// Cargar variables de entorno
dotenv.config();

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!RETELL_API_KEY || RETELL_API_KEY === 'YOUR_RETELL_API_KEY') {
  console.error('\n❌ ERROR: RETELL_API_KEY no configurado en el archivo .env.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const retellClient = axios.create({
  baseURL: 'https://api.retellai.com',
  headers: {
    Authorization: `Bearer ${RETELL_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

function getFormattedToday(): string {
  const formatter = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  return formatter.format(new Date());
}

export async function setupAgent(webhookUrl: string): Promise<string> {
  const existingAgentId: string = 'agent_6712d0dfee1e51d6593032e3e9'; // Carlos Romero en pantalla
  const tenantId = '62d1ed82-287c-4329-941b-50b578c15b14'; // Carlos Romero
  
  console.log(`[Deploy Setup] Leyendo configuraciones de Supabase para el tenant Carlos Romero (${tenantId})...`);
  const { data: tenant, error: getError } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();

  if (getError || !tenant) {
    throw new Error(`Fallo al leer datos del inquilino de Supabase: ${getError?.message}`);
  }

  console.log('Compilando prompt de sistema de Carlos Romero de forma directa y autocontenida...');
  
  // Limpiar instrucciones
  let customPrompt = tenant.custom_instructions || '';
  customPrompt = customPrompt.replace(/# CONTEXTO TEMPORAL[\s\S]*?(?=# PERSONA Y ROL|# PRIVACIDAD|# INFORMACIÓN)/g, '');
  customPrompt = customPrompt.replace(/# MODO VACACIONES[\s\S]*?(?=# PERSONA Y ROL|# PRIVACIDAD|# INFORMACIÓN)/g, '');

  const todayISO = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const todayFormatted = getFormattedToday();
  
  let prefix = `# CONTEXTO TEMPORAL\nLa fecha actual de hoy es: ${todayFormatted} (en formato YYYY-MM-DD: ${todayISO}). Úsala como referencia para calcular fechas relativas como "mañana" (que corresponde al día posterior de la fecha de hoy), "el próximo martes", "la semana que viene", etc.\n\n`;

  if (tenant.vacation_mode) {
    prefix += `# MODO VACACIONES / CIERRE TEMPORAL ACTIVO (CRÍTICO)\nEl establecimiento se encuentra CERRADO por vacaciones o cese temporal de actividad.\n1. Debes comunicar amablemente en la conversación que el negocio está cerrado debido al siguiente motivo/mensaje: "${tenant.vacation_message || 'Estamos cerrados por vacaciones'}".\n2. Todavía puedes agendar nuevas citas en Google Calendar si el usuario lo desea, pero debes indicarle explícitamente que la reserva debe programarse para después del periodo de vacaciones o reapertura del establecimiento, asegurando que sea una fecha y hora hábiles normales.\n\n`;
  }

  const compiledPrompt = prefix + customPrompt.trim();

  const kbId = 'knowledge_base_441d840ae72ab190'; // La nueva base de conocimientos con horarios actualizados

  const llmPayload = {
    general_prompt: compiledPrompt,
    model: 'gpt-4o-mini',
    knowledge_base_ids: [kbId],
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
        url: `${webhookUrl}/api/webhook/get-availability?tenant_id=${tenantId}`,
        execution_message: 'Miro la agenda.',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'La fecha para consultar en formato YYYY-MM-DD (ej. 2026-06-20).',
            },
            time: {
              type: 'string',
              description: 'La hora específica consultada por el cliente en formato HH:MM (ej. 10:30) (opcional). Utilízalo siempre que el cliente pida una hora concreta.'
            }
          },
          required: ['date'],
        },
      },
      {
        type: 'custom',
        name: 'cancelar_cita',
        description: 'Cancela y elimina una cita existente del cliente en la agenda.',
        url: `${webhookUrl}/api/webhook/cancel-appointment?tenant_id=${tenantId}`,
        execution_message: 'Miro para anularla.',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'La fecha de la cita a cancelar en formato YYYY-MM-DD (ej. 2026-06-20) (opcional).',
            },
            time: {
              type: 'string',
              description: 'La hora de la cita a cancelar en formato HH:MM (ej. 10:15) (opcional).',
            },
            phone: {
              type: 'string',
              description: 'El número de teléfono móvil de contacto con el que se registró la cita (opcional). Úsalo si la búsqueda por defecto falla o si el cliente te da un número diferente.'
            }
          }
        }
      },
      {
        type: 'custom',
        name: 'crear_cita',
        description: 'Reserva una cita en la peluquería en el calendario tras confirmar los datos con el cliente.',
        url: `${webhookUrl}/api/webhook/book-appointment?tenant_id=${tenantId}`,
        execution_message: 'Te reservo la cita.',
        parameters: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'La fecha de la cita en formato YYYY-MM-DD (ej. 2026-06-20).',
            },
            time: {
              type: 'string',
              description: 'La hora seleccionada por el cliente en formato HH:MM (ej. 09:30).',
            },
            name: {
              type: 'string',
              description: 'Nombre y apellidos completos del cliente.',
            },
            phone: {
              type: 'string',
              description: 'Número de teléfono de contacto.',
            },
            specialty: {
              type: 'string',
              description: 'El servicio a reservar. Enviar siempre textualmente el valor "Cita Peluquería".',
            },
            duration: {
              type: 'integer',
              description: 'Duración de la cita en minutos (opcional). Obligatorio si reservas citas individuales de un grupo/acompañantes.',
            },
          },
          required: ['date', 'time', 'name', 'phone', 'specialty'],
        },
      },
      {
        type: 'custom',
        name: 'obtener_recuerdos_cliente',
        description: 'Recupera silenciosamente un historial de resúmenes de las llamadas previas que ha realizado este cliente en los últimos 7 días.',
        url: `${webhookUrl}/api/webhook/obtener-recuerdo-cliente?tenant_id=${tenantId}`,
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

  const voiceId = 'custom_voice_c3e5212df87e5341a06ad66e66'; // Voz de María (Gabriela de ElevenLabs)
  
  if (existingAgentId && existingAgentId !== 'YOUR_RETELL_AGENT_ID' && existingAgentId.trim() !== '') {
    try {
      console.log(`🔍 Intentando actualizar el agente existente: ${existingAgentId}...`);
      const agentRes = await retellClient.get(`/get-agent/${existingAgentId}`);
      const llmId = agentRes.data.response_engine?.llm_id;

      if (llmId) {
        console.log(`⚙️ Actualizando LLM existente: ${llmId}...`);
        await retellClient.patch(`/update-retell-llm/${llmId}`, llmPayload);
        console.log('✅ LLM actualizado con el prompt de Carlos Romero.');

        console.log(`⚙️ Actualizando Agente existente: ${existingAgentId}...`);
        await retellClient.patch(`/update-agent/${existingAgentId}`, {
          webhook_url: `${webhookUrl}/api/webhook/agent-events`,
          voice_id: voiceId,
          language: 'es-ES',
          reminder_max_count: 0,
        });
        console.log('✅ Agente de Carlos Romero actualizado.');
        return existingAgentId;
      }
    } catch (e: any) {
      console.warn(`⚠️ No se pudo actualizar el agente existente (${e.message}). Creando uno nuevo...`);
    }
  }

  // Creación fallback si no existe
  console.log('🤖 Creando un nuevo LLM y Agente en Retell AI...');
  const llmRes = await retellClient.post('/v2/create-retell-llm', llmPayload);
  const newLlmId = llmRes.data.llm_id;
  console.log(`✅ LLM creado con ID: ${newLlmId}`);

  const agentPayload = {
    agent_name: 'María - Peluquería Carlos Romero',
    response_engine: {
      type: 'retell-llm',
      llm_id: newLlmId,
    },
    voice_id: voiceId,
    language: 'es-ES',
    webhook_url: `${webhookUrl}/api/webhook/agent-events`,
    fallback_voice_ids: [],
    opt_out_sensitive_data_encryption: false,
    reminder_max_count: 0,
  };

  const agentRes = await retellClient.post('/create-agent', agentPayload);
  const newAgentId = agentRes.data.agent_id;
  console.log(`✅ Agente creado con ID: ${newAgentId}`);

  // Guardar de vuelta el nuevo ID en Supabase
  await supabase
    .from('tenants')
    .update({ retell_agent_id: newAgentId })
    .eq('id', tenantId);

  return newAgentId;
}
