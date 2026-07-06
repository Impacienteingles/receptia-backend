import axios from 'axios';
import * as dotenv from 'dotenv';
import { supabase, getSettingVal } from '../src/services/supabase';
import { compileSystemPrompt } from '../src/services/retell';

dotenv.config();

function formatToE164(phone: string): string {
  const clean = phone.replace(/[\s\-\(\)]/g, '');
  if (clean.startsWith('+')) {
    return clean;
  }
  if (clean.length === 9 && /^[6789]/.test(clean)) {
    return `+34${clean}`;
  }
  return `+${clean}`;
}

async function setupElevenLabs(tenantId: string) {
  const elevenApiKey = await getSettingVal('ELEVENLABS_API_KEY') || process.env.ELEVENLABS_API_KEY;
  if (!elevenApiKey) {
    throw new Error('Falta configurar ELEVENLABS_API_KEY en la base de datos o env');
  }

  // 1. Fetch Tenant from DB
  const { data: tenant, error: tenantErr } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();

  if (tenantErr || !tenant) {
    throw new Error(`No se encontró el inquilino en la base de datos para ID: ${tenantId}`);
  }

  // Determine the phone number to configure (use virtual phone number assigned)
  let assignedPhone = tenant.phone_number;
  const { data: vpData } = await supabase
    .from('virtual_phones')
    .select('phone_number')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (vpData?.phone_number) {
    assignedPhone = vpData.phone_number;
  }

  if (!assignedPhone) {
    throw new Error('El inquilino no tiene ningún número de teléfono asignado para enrutar');
  }

  const cleanE164 = formatToE164(assignedPhone);

  console.log(`\n⚙️ Configurando ElevenLabs para ${tenant.business_name}. Teléfono: ${cleanE164}`);

  // 2. Compile system prompt
  const globalKnowledge = await getSettingVal('global_ai_knowledge') || '';
  const systemPrompt = compileSystemPrompt(tenant, globalKnowledge);

  // 3. Clean up existing tools in ElevenLabs for this tenant only
  const listRes = await axios.get('https://api.elevenlabs.io/v1/convai/tools', {
    headers: { 'xi-api-key': elevenApiKey }
  });
  
  const existingTools = listRes.data.tools || [];
  const targetToolNames = ['consultar_disponibilidad', 'crear_cita', 'cancelar_cita', 'reprogramar_cita', 'obtener_telefono_negocio'];
  
  for (const tool of existingTools) {
    const toolName = tool.tool_config?.name;
    const toolUrl = tool.tool_config?.api_schema?.url || '';
    
    if (targetToolNames.includes(toolName) && toolUrl.includes(`tenant_id=${tenantId}`)) {
      console.log(`Eliminando herramienta existente duplicada: ${toolName} (${tool.id})...`);
      try {
        await axios.delete(`https://api.elevenlabs.io/v1/convai/tools/${tool.id}`, {
          headers: { 'xi-api-key': elevenApiKey }
        });
      } catch (err: any) {
        console.error(`Error deleting tool ${toolName}:`, err.message);
      }
    }
  }

  // 4. Define and Create fresh tools
  const webhookBaseUrl = 'https://corandar.onrender.com';
  const toolsDefinitions = [
    {
      tool_config: {
        type: 'webhook',
        name: 'obtener_recuerdos_cliente',
        description: 'Recupera silenciosamente un historial de resúmenes de las llamadas previas que ha realizado este cliente en los últimos 7 días.',
        api_schema: {
          url: `${webhookBaseUrl}/api/webhook/obtener-recuerdo-cliente?tenant_id=${tenantId}`,
          method: 'POST',
          request_headers: { 'Content-Type': 'application/json' },
          request_body_schema: {
            type: 'object',
            properties: {
              phone: {
                type: 'string',
                dynamic_variable: 'system__caller_id'
              }
            },
            required: ['phone']
          }
        }
      }
    },
    {
      tool_config: {
        type: 'webhook',
        name: 'consultar_disponibilidad',
        description: 'Consulta los horarios disponibles para una fecha específica (formato YYYY-MM-DD). Devuelve las horas libres en formato HH:MM.',
        api_schema: {
          url: `${webhookBaseUrl}/api/webhook/get-availability?tenant_id=${tenantId}`,
          method: 'POST',
          request_headers: { 'Content-Type': 'application/json' },
          request_body_schema: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'La fecha en formato YYYY-MM-DD.' },
              specialty: { type: 'string', description: 'El servicio o grupo de personas.' }
            },
            required: ['date']
          }
        }
      }
    },
    {
      tool_config: {
        type: 'webhook',
        name: 'crear_cita',
        description: 'Reserva una cita en el calendario tras confirmar los datos con el cliente.',
        api_schema: {
          url: `${webhookBaseUrl}/api/webhook/book-appointment?tenant_id=${tenantId}`,
          method: 'POST',
          request_headers: { 'Content-Type': 'application/json' },
          request_body_schema: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'Fecha YYYY-MM-DD.' },
              time: { type: 'string', description: 'Hora HH:MM.' },
              name: { type: 'string', description: 'Nombre completo.' },
              phone: { type: 'string', description: 'Teléfono.' },
              specialty: { type: 'string', description: 'Servicio.' },
              email: { type: 'string', description: 'Email.' },
              duration: { type: 'integer', description: 'Duración en minutos (opcional). Obligatorio si reservas citas individuales de un grupo/acompañantes.' }
            },
            required: ['date', 'time', 'name', 'phone', 'specialty']
          }
        }
      }
    },
    {
      tool_config: {
        type: 'webhook',
        name: 'cancelar_cita',
        description: 'Cancela y elimina una cita existente.',
        api_schema: {
          url: `${webhookBaseUrl}/api/webhook/cancel-appointment?tenant_id=${tenantId}`,
          method: 'POST',
          request_headers: { 'Content-Type': 'application/json' },
          request_body_schema: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'Fecha YYYY-MM-DD.' },
              phone: { type: 'string', description: 'Teléfono.' }
            },
            required: ['date', 'phone']
          }
        }
      }
    },
    {
      tool_config: {
        type: 'webhook',
        name: 'reprogramar_cita',
        description: 'Reprograma una cita existente a una nueva fecha y hora.',
        api_schema: {
          url: `${webhookBaseUrl}/api/webhook/reschedule-appointment?tenant_id=${tenantId}`,
          method: 'POST',
          request_headers: { 'Content-Type': 'application/json' },
          request_body_schema: {
            type: 'object',
            properties: {
              original_date: { type: 'string', description: 'Fecha original YYYY-MM-DD.' },
              new_date: { type: 'string', description: 'Nueva fecha YYYY-MM-DD.' },
              new_time: { type: 'string', description: 'Nueva hora HH:MM.' },
              phone: { type: 'string', description: 'Teléfono.' }
            },
            required: ['original_date', 'new_date', 'new_time', 'phone']
          }
        }
      }
    },
    {
      tool_config: {
        type: 'webhook',
        name: 'obtener_telefono_negocio',
        description: 'Busca el número de teléfono virtual de un negocio por su nombre para poder transferirle la llamada.',
        api_schema: {
          url: `${webhookBaseUrl}/api/webhook/get-business-phone?tenant_id=${tenantId}`,
          method: 'POST',
          request_headers: { 'Content-Type': 'application/json' },
          request_body_schema: {
            type: 'object',
            properties: {
              business_name: { type: 'string', description: 'El nombre del negocio del que se desea buscar el teléfono o demostración.' }
            },
            required: ['business_name']
          }
        }
      }
    }
  ];

  const toolIds: string[] = [];
  for (const toolDef of toolsDefinitions) {
    try {
      const createRes = await axios.post('https://api.elevenlabs.io/v1/convai/tools', toolDef, {
        headers: { 'xi-api-key': elevenApiKey }
      });
      const toolId = createRes.data.id || createRes.data.tool_id;
      toolIds.push(toolId);
      console.log(`Creada herramienta ElevenLabs: ${toolDef.tool_config.name} (${toolId})`);
    } catch (err: any) {
      console.error(`Error creating tool ${toolDef.tool_config.name}:`, err.response?.data || err.message);
    }
  }

  // 5. Create ElevenLabs Agent
  let firstMessage = `${tenant.business_name}, ¿en qué le puedo ayudar?`;
  if (tenant.business_name.includes('Demostraciones')) {
    firstMessage = 'Hola, estás llamando al Departamento de Demostraciones de Receptia. ¿De qué negocio te gustaría escuchar la demostración hoy?';
  } else if (tenant.business_name.includes('Atención al Cliente')) {
    firstMessage = 'Hola, bienvenido al canal de atención al cliente de Receptia. ¿En qué puedo ayudarte hoy?';
  }

  const voiceResp = (tenant.voice_responsiveness !== undefined && tenant.voice_responsiveness !== null) ? Number(tenant.voice_responsiveness) : 1.0;
  const computedTurnTimeout = Math.max(0.5, Math.min(3.0, 1.2 / (voiceResp || 1.0)));

  const agentPayload = {
    name: tenant.business_name,
    conversation_config: {
      agent: {
        first_message: firstMessage,
        prompt: {
          prompt: systemPrompt,
          tool_ids: toolIds,
          llm: 'gpt-4o-mini',
          temperature: 0.3,
          built_in_tools: {
            end_call: {
              name: 'end_call',
              params: {
                system_tool_type: 'end_call'
              },
              type: 'system'
            },
            transfer_to_number: {
              name: 'transfer_to_number',
              params: {
                system_tool_type: 'transfer_to_number'
              },
              type: 'system'
            }
          }
        },
        language: 'es'
      },
      tts: {
        model_id: 'eleven_flash_v2_5',
        voice_id: (!tenant.voice_id || tenant.voice_id.includes('cartesia') || tenant.voice_id.length !== 20) ? 'ERYLdjEaddaiN9sDjaMX' : tenant.voice_id, // Gabriela voice
        speed: 1.09,
        stability: 0.40,
        similarity_boost: 0.85
      },
      turn: {
        turn_timeout: 1,
        turn_eagerness: 'eager'
      },
      conversation: {
        client_events: [
          'audio',
          'interruption',
          'agent_response',
          'user_transcript',
          'agent_response_correction',
          'agent_tool_response'
        ]
      }
    }
  };

  console.log(`🤖 Creando Agente en ElevenLabs para ${tenant.business_name}...`);
  const createAgentRes = await axios.post('https://api.elevenlabs.io/v1/convai/agents/create', agentPayload, {
    headers: { 'xi-api-key': elevenApiKey }
  });
  const agentId = createAgentRes.data.agent_id;
  console.log(`✅ Nuevo agente creado en ElevenLabs con ID: ${agentId}`);

  // 6. Import/Update SIP Trunk Phone Number in ElevenLabs
  try {
    const phoneListRes = await axios.get('https://api.elevenlabs.io/v1/convai/phone-numbers', {
      headers: { 'xi-api-key': elevenApiKey }
    });

    const existingNumbers = phoneListRes.data || [];
    const matchedNumber = existingNumbers.find((n: any) => n.phone_number === cleanE164);
    
    let phoneNumberId = '';

    const phonePayload = {
      phone_number: cleanE164,
      label: tenant.business_name,
      provider: 'sip_trunk',
      agent_id: agentId,
      inbound_trunk_config: {
        allowed_addresses: ['0.0.0.0/0'],
        media_encryption: 'allowed',
        credentials: null
      }
    };

    if (matchedNumber) {
      phoneNumberId = matchedNumber.phone_number_id;
      console.log(`Actualizando asignación de número existente: ${cleanE164} (${phoneNumberId}) -> Agente: ${agentId}`);
      await axios.patch(`https://api.elevenlabs.io/v1/convai/phone-numbers/${phoneNumberId}`, {
        label: tenant.business_name,
        agent_id: agentId
      }, {
        headers: { 'xi-api-key': elevenApiKey }
      });
    } else {
      console.log(`Registrando nuevo número en ElevenLabs: ${cleanE164} -> Agente: ${agentId}`);
      const createPhoneRes = await axios.post('https://api.elevenlabs.io/v1/convai/phone-numbers', phonePayload, {
        headers: { 'xi-api-key': elevenApiKey }
      });
      phoneNumberId = createPhoneRes.data.phone_number_id;
    }
    console.log(`✅ Número de teléfono ${cleanE164} asignado con éxito.`);
  } catch (phoneErr: any) {
    console.error(`Error al configurar número en ElevenLabs:`, phoneErr.response?.data || phoneErr.message);
  }

  // 7. Save agentId in database
  const { error: updateErr } = await supabase
    .from('tenants')
    .update({ retell_agent_id: agentId })
    .eq('id', tenantId);

  if (updateErr) {
    throw new Error(`Error al actualizar retell_agent_id en Supabase: ${updateErr.message}`);
  }
  console.log(`✅ Supabase actualizado exitosamente.`);
}

async function main() {
  const newTenants = [
    { id: '62d1ed82-287c-4329-941b-50b578c15b14', name: 'Peluquería Carlos Romero' },
    { id: '22222222-2222-2222-2222-222222222222', name: 'Peluquería Duo Peluqueros' },
    { id: '33333333-3333-3333-3333-333333333333', name: 'Peluquería La Niña de los Peines' },
    { id: '44444444-4444-4444-4444-444444444444', name: 'Caravaning Plaza' },
    { id: '77777777-7777-7777-7777-777777777777', name: 'Receptia Atención al Cliente' },
    { id: 'd1180213-8036-4acd-a6de-3e3287ba73dc', name: 'Receptia Departamento de Demostraciones' }
  ];

  for (const t of newTenants) {
    try {
      await setupElevenLabs(t.id);
    } catch (e: any) {
      console.error(`❌ Falló la configuración de ${t.name}:`, e.message);
    }
  }
  console.log('\n🎉 PROCESO COMPLETADO DE CREACIÓN DE AGENTES');
  process.exit(0);
}

main();
