import { Router, Request, Response } from 'express';
import axios from 'axios';
import { supabase, getSettingVal } from '../services/supabase';
import { compileSystemPrompt } from '../services/retell';
import { callZadarma } from './zadarma';

const router = Router();

// Helper to format phone number to E.164 (e.g., +34858215153)
function formatToE164(phone: string): string {
  let cleaned = phone.replace(/[\s\-\(\)\+]/g, '');
  if (!cleaned.startsWith('34') && cleaned.length === 9) {
    cleaned = '34' + cleaned;
  }
  return '+' + cleaned;
}

// Helper to format number for Zadarma (no + sign, e.g., 34858215153)
function formatForZadarma(phone: string): string {
  return phone.replace(/[\s\-\(\)\+]/g, '');
}

// POST /api/admin/tenants/:id/setup-elevenlabs
router.post('/tenants/:id/setup-elevenlabs', async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  try {
    const elevenApiKey = await getSettingVal('ELEVENLABS_API_KEY');
    if (!elevenApiKey) {
      return res.status(400).json({ error: 'Falta configurar ELEVENLABS_API_KEY en la base de datos' });
    }

    // 1. Fetch Tenant from DB
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', tenantId)
      .single();

    if (tenantErr || !tenant) {
      return res.status(404).json({ error: 'No se encontró el inquilino en la base de datos' });
    }

    // Determine the phone number to configure (use virtual phone number assigned)
    let assignedPhone = tenant.phone_number;
    // Check if there is an assigned virtual phone in database
    const { data: vpData } = await supabase
      .from('virtual_phones')
      .select('phone_number')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (vpData?.phone_number) {
      assignedPhone = vpData.phone_number;
    }

    if (!assignedPhone) {
      return res.status(400).json({ error: 'El inquilino no tiene ningún número de teléfono asignado para enrutar' });
    }

    const cleanE164 = formatToE164(assignedPhone);
    const cleanZadarma = formatForZadarma(assignedPhone);

    console.log(`Setting up ElevenLabs for ${tenant.business_name}. Phone: ${cleanE164}`);

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
      
      // Delete if name matches AND the webhook URL contains this tenant's ID
      if (targetToolNames.includes(toolName) && toolUrl.includes(`tenant_id=${tenantId}`)) {
        console.log(`Deleting existing duplicate tool for this tenant: ${toolName} (${tool.id})...`);
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
        toolIds.push(createRes.data.id || createRes.data.tool_id);
      } catch (err: any) {
        console.error(`Error creating tool ${toolDef.tool_config.name}:`, err.response?.data || err.message);
      }
    }

    // 5. Create or Update ElevenLabs Agent
    let agentId = tenant.retell_agent_id;
    let isNewAgent = false;

    let firstMessage = `${tenant.business_name}, ¿en qué le puedo ayudar?`;
    if (tenant.business_name.includes('Demostraciones')) {
      firstMessage = 'Hola, bienvenido al departamento de demostraciones de Receptia. ¿En qué te puedo ayudar hoy? ¿Has llamado para escuchar la demostración de algún negocio en concreto?';
    } else if (tenant.business_name.includes('Atención al Cliente')) {
      firstMessage = 'Hola, bienvenido al canal de atención al cliente de Receptia. ¿En qué puedo ayudarte hoy?';
    }

    let cleanVoiceId = tenant.voice_id || '';
    if (cleanVoiceId.startsWith('elevenlabs_')) {
      cleanVoiceId = cleanVoiceId.replace('elevenlabs_', '');
    } else if (cleanVoiceId.startsWith('elevenlabs:')) {
      cleanVoiceId = cleanVoiceId.replace('elevenlabs:', '');
    } else if (cleanVoiceId.startsWith('11labs_')) {
      cleanVoiceId = cleanVoiceId.replace('11labs_', '');
    }
    const finalVoiceId = (cleanVoiceId && !cleanVoiceId.includes('cartesia') && cleanVoiceId.length === 20) ? cleanVoiceId : 'ERYLdjEaddaiN9sDjaMX';

    const voiceResp = (tenant.voice_responsiveness !== undefined && tenant.voice_responsiveness !== null) ? Number(tenant.voice_responsiveness) : 1.0;
    const computedTurnTimeout = Math.max(0.5, Math.min(3.0, 1.2 / (voiceResp || 1.0)));

    // Configurar herramientas de sistema (built_in_tools)
    const isDemoDept = tenant.id === 'd1180213-8036-4acd-a6de-3e3287ba73dc';
    const builtInTools: any = {
      end_call: {
        name: 'end_call',
        params: {
          system_tool_type: 'end_call'
        },
        type: 'system'
      }
    };

    if (isDemoDept) {
      const { data: otherTenants } = await supabase
        .from('tenants')
        .select('id, business_name, retell_agent_id')
        .neq('id', tenant.id)
        .eq('is_archived', false)
        .in('subscription_status', ['active', 'trial'])
        .not('retell_agent_id', 'is', null);

      if (otherTenants && otherTenants.length > 0) {
        const transfers = otherTenants
          .filter(t => t.retell_agent_id && t.retell_agent_id.trim() !== '')
          .map(t => ({
            agent_id: t.retell_agent_id,
            condition: `El usuario solicita escuchar la demostración de ${t.business_name}`,
            enable_transferred_agent_first_message: true
          }));

        if (transfers.length > 0) {
          builtInTools.transfer_to_agent = {
            name: 'transfer_to_agent',
            params: {
              system_tool_type: 'transfer_to_agent',
              transfers: transfers
            },
            type: 'system'
          };
        }
      }
    }

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
            built_in_tools: builtInTools
          },
          language: 'es'
        },
        tts: {
          model_id: 'eleven_flash_v2_5',
          voice_id: finalVoiceId,
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

    if (agentId && agentId.startsWith('agent_')) {
      // Try updating existing
      try {
        await axios.patch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, agentPayload, {
          headers: { 'xi-api-key': elevenApiKey }
        });
        console.log(`Agent ${agentId} updated successfully.`);
      } catch (err: any) {
        console.warn(`Could not update agent ${agentId} (404/expired). Creating new...`);
        isNewAgent = true;
      }
    } else {
      isNewAgent = true;
    }

    if (isNewAgent) {
      const createAgentRes = await axios.post('https://api.elevenlabs.io/v1/convai/agents/create', agentPayload, {
        headers: { 'xi-api-key': elevenApiKey }
      });
      agentId = createAgentRes.data.agent_id;
      console.log(`New agent created in ElevenLabs: ${agentId}`);
    }

    // 6. Import/Update SIP Trunk Phone Number in ElevenLabs
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
      },
      outbound_trunk_config: {
        address: 'pbx.zadarma.com',
        transport: 'tcp',
        media_encryption: 'allowed',
        credentials: null
      }
    };

    if (matchedNumber) {
      phoneNumberId = matchedNumber.phone_number_id;
      console.log(`Number ${cleanE164} found. Updating agent mapping...`);
      await axios.patch(`https://api.elevenlabs.io/v1/convai/phone-numbers/${phoneNumberId}`, {
        label: tenant.business_name,
        agent_id: agentId,
        inbound_trunk_config: phonePayload.inbound_trunk_config,
        outbound_trunk_config: phonePayload.outbound_trunk_config
      }, {
        headers: { 'xi-api-key': elevenApiKey }
      });
    } else {
      console.log(`Number ${cleanE164} not found. Importing to ElevenLabs...`);
      const importRes = await axios.post('https://api.elevenlabs.io/v1/convai/phone-numbers', phonePayload, {
        headers: { 'xi-api-key': elevenApiKey }
      });
      phoneNumberId = importRes.data.phone_number_id;
    }

    // 7. Route the Zadarma virtual number to the ElevenLabs SIP URI
    const zadarmaUser = await getSettingVal('ZADARMA_API_USER');
    const zadarmaSecret = await getSettingVal('ZADARMA_API_KEY');

    if (zadarmaUser && zadarmaSecret) {
      const sipUri = `${cleanZadarma}@sip.rtc.elevenlabs.io:5060;transport=tcp`;
      console.log(`Configuring Zadarma redirect of ${cleanZadarma} to ${sipUri}...`);
      try {
        await callZadarma('/v1/direct_numbers/set_sip_id/', zadarmaUser, zadarmaSecret, 'PUT', {
          number: cleanZadarma,
          sip_id: sipUri
        });
        console.log(`Zadarma routing configured successfully.`);
      } catch (err: any) {
        console.error(`Failed to route Zadarma number:`, err.response?.data || err.message);
      }
    } else {
      console.warn('Zadarma credentials not found in settings. Skipping Zadarma redirection.');
    }

    // 8. Update Supabase Tenant Record
    await supabase
      .from('tenants')
      .update({
        retell_agent_id: agentId,
        sip_username: cleanZadarma,
        sip_server: 'sip.rtc.elevenlabs.io',
        updated_at: new Date().toISOString()
      })
      .eq('id', tenantId);

    res.json({
      status: 'success',
      agent_id: agentId,
      phone_number_id: phoneNumberId,
      phone_number: cleanE164,
      message: 'Aprovisionamiento completo de telefonía y agente en ElevenLabs + Zadarma realizado con éxito.'
    });

  } catch (error: any) {
    console.error('Error during setup-elevenlabs execution:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Fallo al aprovisionar ElevenLabs / Zadarma',
      details: error.response?.data || error.message
    });
  }
});

export default router;
