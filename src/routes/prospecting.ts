import { Router, Request, Response } from 'express';
import { supabase, getSettingVal } from '../services/supabase';
import { scrapeProspects, scrapeSingleBusiness } from '../services/scraper';
import { sendOutreachEmail, getOutreachEmailTemplate } from '../services/outreach';
import { createRetellAgentForTenant, deleteRetellAgent } from '../services/retell';
import axios from 'axios';

const router = Router();

/**
 * 1. Obtener todos los prospectos guardados
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('prospects')
      .select(`
        *,
        tenants:demo_tenant_id (
          contract_start_date
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    
    const mapped = (data || []).map((p: any) => ({
      ...p,
      comercial_id: p.commercial_agent_id
    }));
    
    res.json({ prospects: mapped });
  } catch (error: any) {
    console.error('[Prospecting API] Error al obtener prospectos:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 2. Agregar un prospecto de forma manual
 */
router.post('/manual', async (req: Request, res: Response): Promise<void> => {
  const { business_name, phone, email, website, city, country, sector } = req.body;

  if (!business_name || !city || !country || !sector) {
    res.status(400).json({ error: 'Los campos nombre, ciudad, país y sector son requeridos.' });
    return;
  }

  try {
    const normalizeString = (str: string): string => {
      if (!str) return '';
      return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '')
        .trim();
    };

    const normalizePhone = (p: string): string => {
      if (!p || p === 'No disponible') return '';
      return p.replace(/[^0-9]/g, '');
    };

    const normalizeWebsite = (url: string): string => {
      if (!url || url === 'No disponible' || url.includes('google.com')) return '';
      return url
        .toLowerCase()
        .replace(/^(https?:\/\/)?(www\.)?/, '')
        .replace(/\/$/, '')
        .trim();
    };

    // Obtener los prospectos existentes para deduplicación
    const { data: dbProspects, error: fetchErr } = await supabase
      .from('prospects')
      .select('id, business_name, email, phone, website, sector');
    
    if (fetchErr) throw fetchErr;

    const normName = normalizeString(business_name);
    const normPhone = normalizePhone(phone);
    const normWebsite = normalizeWebsite(website || '');
    const normEmail = email && email.trim() !== '' ? email.trim().toLowerCase() : '';

    let isDuplicate = false;
    for (const existing of dbProspects || []) {
      if (existing.sector !== sector) continue;

      if (normName && normalizeString(existing.business_name) === normName) {
        isDuplicate = true;
        break;
      }
      if (normPhone && normalizePhone(existing.phone) === normPhone) {
        isDuplicate = true;
        break;
      }
      if (normEmail && existing.email && existing.email.trim().toLowerCase() === normEmail) {
        isDuplicate = true;
        break;
      }
      if (normWebsite && existing.website && normalizeWebsite(existing.website) === normWebsite) {
        isDuplicate = true;
        break;
      }
    }

    if (isDuplicate) {
      res.status(409).json({ error: 'Ya existe un prospecto en este sector con el mismo nombre, teléfono, correo o web.' });
      return;
    }

    // Ejecutar raspado en segundo plano de forma síncrona para recopilar información y llenar la base de conocimiento
    const scrapeResult = await scrapeSingleBusiness(business_name, sector, website || '', city);
    const finalEmail = email || scrapeResult.email || null;
    const finalSpecialties = scrapeResult.specialties || [];
    const scrapedKnowledge = scrapeResult.scraped_knowledge || '';

    const { data, error } = await supabase
      .from('prospects')
      .insert({
        business_name,
        phone: phone || null,
        email: finalEmail,
        website: website || null,
        city,
        country,
        sector,
        specialties: finalSpecialties,
        scraped_knowledge: scrapedKnowledge,
        is_manual: true,
        status: 'extracted',
        classification: 'no_contactado',
        tags: []
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: 'Prospecto manual agregado con éxito y analizado por el scraper.', prospect: data });
  } catch (error: any) {
    console.error('[Prospecting API] Error al agregar prospecto manual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 3. Buscar y extraer prospectos de Google Maps y scraping web
 */
router.post('/search', async (req: Request, res: Response): Promise<void> => {
  const { city, country, sector } = req.body;

  if (!city || !country || !sector) {
    res.status(400).json({ error: 'Los parámetros city, country y sector son requeridos.' });
    return;
  }

  try {
    console.log(`[Prospecting API] Iniciando búsqueda de leads en ${city}, ${country} para sector ${sector}...`);
    
    // Obtener leads (Maps + Scraping)
    const leads = await scrapeProspects(city, country, sector);

    if (leads.length === 0) {
      res.json({ status: 'success', message: 'No se encontraron negocios para los parámetros indicados.', prospects: [] });
      return;
    }

    const insertedProspects: any[] = [];

    // Normalization helper functions
    const normalizeString = (str: string): string => {
      if (!str) return '';
      return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // remove accents/diacritics
        .replace(/[^a-z0-9]/g, '') // remove non-alphanumeric characters
        .trim();
    };

    const normalizePhone = (phone: string): string => {
      if (!phone || phone === 'No disponible') return '';
      return phone.replace(/[^0-9]/g, ''); // keep only digits
    };

    const normalizeWebsite = (url: string): string => {
      if (!url || url === 'No disponible' || url.includes('google.com')) return '';
      return url
        .toLowerCase()
        .replace(/^(https?:\/\/)?(www\.)?/, '') // remove http/https/www
        .replace(/\/$/, '') // remove trailing slash
        .trim();
    };

    // Fetch all existing prospects to check duplicates in-memory (highly robust)
    const { data: dbProspects, error: fetchErr } = await supabase
      .from('prospects')
      .select('id, business_name, address, email, phone, website, sector');
    
    if (fetchErr) {
      console.error('[Prospecting API] Error al cargar prospectos existentes para deduplicación:', fetchErr.message);
    }
    
    const existingProspects = dbProspects || [];

    // Guardar leads en Supabase
    for (const lead of leads) {
      let isDuplicate = false;

      const normLeadName = normalizeString(lead.business_name);
      const normLeadAddress = normalizeString(lead.address);
      const normLeadEmail = lead.email && lead.email.trim() !== '' && lead.email !== 'No disponible' && !lead.email.includes('example.com')
        ? lead.email.trim().toLowerCase()
        : '';
      const normLeadPhone = normalizePhone(lead.phone);
      const normLeadWebsite = normalizeWebsite(lead.website);

      for (const existing of existingProspects) {
        // Solo comprobar duplicados dentro del mismo sector
        if (existing.sector !== lead.sector) {
          continue;
        }

        // 1. Check normalized business name AND address
        if (normLeadName && normLeadAddress && 
            normLeadName === normalizeString(existing.business_name) && 
            normLeadAddress === normalizeString(existing.address)) {
          isDuplicate = true;
          break;
        }

        // 2. Check normalized email
        if (normLeadEmail && existing.email && 
            normLeadEmail === existing.email.trim().toLowerCase()) {
          isDuplicate = true;
          break;
        }

        // 3. Check normalized phone
        if (normLeadPhone) {
          const existingPhoneNorm = normalizePhone(existing.phone);
          if (existingPhoneNorm && normLeadPhone === existingPhoneNorm) {
            isDuplicate = true;
            break;
          }
        }

        // 4. Check normalized website
        if (normLeadWebsite) {
          const existingWebsiteNorm = normalizeWebsite(existing.website);
          if (existingWebsiteNorm && normLeadWebsite === existingWebsiteNorm) {
            isDuplicate = true;
            break;
          }
        }
      }

      if (isDuplicate) {
        console.log(`[Prospecting API] Lead duplicado omitido (Normalizado): ${lead.business_name} (${lead.email || lead.phone || lead.website || lead.address})`);
        continue;
      }

      const { data, error } = await supabase
        .from('prospects')
        .insert({
          business_name: lead.business_name,
          email: lead.email,
          phone: lead.phone,
          website: lead.website,
          address: lead.address,
          sector: lead.sector,
          specialties: lead.specialties,
          scraped_knowledge: lead.scraped_knowledge,
          status: 'extracted',
          city: lead.city || city
        })
        .select('*')
        .single();

      if (error) {
        console.error('[Prospecting API] Error al guardar lead:', error.message);
      } else if (data) {
        insertedProspects.push(data);
      }
    }

    const mapped = (insertedProspects || []).map((p: any) => ({
      ...p,
      comercial_id: p.commercial_agent_id
    }));

    res.json({
      status: 'success',
      message: `Se han extraído e insertado ${insertedProspects.length} nuevos leads con éxito.`,
      prospects: mapped
    });
  } catch (error: any) {
    console.error('[Prospecting API] Error en la extracción:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 3. Lanzar pipeline de Demo asíncrono para un prospecto
 */
router.post('/trigger-pipeline', async (req: Request, res: Response): Promise<void> => {
  const { prospect_id, base_tenant_id, override_data } = req.body;

  if (!prospect_id) {
    res.status(400).json({ error: 'El prospect_id es obligatorio.' });
    return;
  }

  // Actualizar estado a 'extracted' y limpiar errores anteriores de inmediato para reiniciar la barra en la interfaz
  try {
    await supabase
      .from('prospects')
      .update({ status: 'extracted', error_details: null })
      .eq('id', prospect_id);
  } catch (resetErr: any) {
    console.warn(`[Pipeline Reset WARNING] No se pudo reiniciar el estado del prospecto ${prospect_id}:`, resetErr.message);
  }

  // Responder inmediatamente de forma asíncrona para no congelar el servidor
  res.json({ status: 'processing', message: 'El pipeline de demostración se ha iniciado en segundo plano.' });

  // Ejecutar el pipeline de forma asíncrona
  runOutreachPipeline(
    prospect_id,
    req.headers.origin || 'https://receptia.corandar.com',
    base_tenant_id,
    override_data
  ).catch(err => {
    console.error(`[Pipeline Error Critical] Error general en el pipeline del prospecto ${prospect_id}:`, err.message);
  });
});

/**
 * Función que orquesta todo el flujo asíncrono del pipeline
 */
async function runOutreachPipeline(prospectId: string, origin: string, baseTenantId?: string, overrideData?: any) {
  console.log(`[Pipeline] 🏁 Iniciando pipeline para prospecto: ${prospectId}...`);

  try {
    // 1. Cargar datos del prospecto
    const { data: prospect, error: fetchErr } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', prospectId)
      .single();

    if (fetchErr || !prospect) {
      throw new Error(`No se pudo cargar el prospecto: ${fetchErr?.message || 'No encontrado'}`);
    }

    // Unificar datos usando posibles overrides ingresados por el usuario
    const businessName = overrideData?.business_name || prospect.business_name;
    const email = overrideData?.email || prospect.email || `contacto@${businessName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;
    const phone = overrideData?.phone || prospect.phone;
    const website = overrideData?.website || prospect.website;
    const address = overrideData?.address || prospect.address;
    const sector = overrideData?.sector || prospect.sector;
    let specialties = overrideData?.specialties || prospect.specialties || [];
    if (typeof specialties === 'string') {
      specialties = (specialties as string).split(',').map(s => s.trim()).filter(Boolean);
    }

    // 2. Cargar tenant base (si se provee) para la clonación inteligente
    let baseTenant: any = null;
    if (baseTenantId) {
      console.log(`[Pipeline] Buscando tenant base para clonación inteligente con ID: ${baseTenantId}...`);
      const { data, error } = await supabase
        .from('tenants')
        .select('*')
        .eq('id', baseTenantId)
        .maybeSingle();
      if (!error && data) {
        baseTenant = data;
        console.log(`[Pipeline] Tenant base encontrado: ${baseTenant.business_name}`);
      }
    }

    // 3. Crear Tenant Demo en la base de datos
    console.log(`[Pipeline] [Paso 1] Creando Tenant Demo para: ${businessName}...`);
    
    // Si ya tiene un tenant demo creado de antes, lo reutilizamos
    let tenantId = prospect.demo_tenant_id;
    let demoUrl = prospect.demo_url;

    if (!tenantId) {
      // Definir parámetros a heredar del baseTenant o fallbacks por defecto
      const voiceId = overrideData?.voice_id || baseTenant?.voice_id || 'cartesia-Hailey-Spanish-latin-america';
      const voiceSpeed = overrideData?.voice_speed !== undefined ? Number(overrideData.voice_speed) : (baseTenant?.voice_speed !== undefined && baseTenant?.voice_speed !== null ? Number(baseTenant.voice_speed) : 1.0);
      const voiceTemperature = overrideData?.voice_temperature !== undefined ? Number(overrideData.voice_temperature) : (baseTenant?.voice_temperature !== undefined && baseTenant?.voice_temperature !== null ? Number(baseTenant.voice_temperature) : 1.0);
      const voiceResponsiveness = overrideData?.voice_responsiveness !== undefined ? Number(overrideData.voice_responsiveness) : (baseTenant?.voice_responsiveness !== undefined && baseTenant?.voice_responsiveness !== null ? Number(baseTenant.voice_responsiveness) : 1.0);
      
      const workingHours = baseTenant?.working_hours || {
        lunes: [{ start: '09:00', end: '19:00' }],
        martes: [{ start: '09:00', end: '19:00' }],
        miercoles: [{ start: '09:00', end: '19:00' }],
        jueves: [{ start: '09:00', end: '19:00' }],
        viernes: [{ start: '09:00', end: '19:00' }]
      };

      // Si hay custom_instructions en el baseTenant, las adaptamos sustituyendo el nombre del comercio antiguo por el nuevo
      let customInstructions = baseTenant?.custom_instructions || `Eres Elena, la asistente virtual de ${businessName}. Saluda amablemente, responde preguntas basadas en el negocio, y ofrece al interlocutor registrar una cita de prueba de forma natural y educada.`;
      if (baseTenant?.custom_instructions && baseTenant?.business_name) {
        const regex = new RegExp(baseTenant.business_name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
        customInstructions = customInstructions.replace(regex, businessName);
      }

      // Si el prospecto tiene conocimiento extraído de la web, inyectarlo al prompt del agente de voz
      if (prospect.scraped_knowledge) {
        customInstructions += `\n\n# CONOCIMIENTO ADICIONAL SOBRE EL NEGOCIO (EXTRAÍDO DE SU WEB):\n${prospect.scraped_knowledge}`;
      }

      // Generar base de conocimientos y descripciones ricas
      const businessDescription = `Demostración de asistente de voz inteligente configurada para el negocio "${businessName}" (Sector: ${sector || 'Servicios'}).`;
      const pricingDetails = `Nuestras tarifas para los servicios de ${specialties.length > 0 ? specialties.join(', ') : 'nuestras especialidades'} se adaptan de forma personalizada. Póngase en contacto con recepción para recibir un presupuesto detallado.`;
      const kbContent = `Información general del establecimiento:
- Nombre Comercial: ${businessName}
- Dirección Legal: ${address || 'No especificada'}
- Sector del Negocio: ${sector || 'Servicios'}
- Teléfono de Contacto: ${phone || 'No especificado'}
- Especialidades / Servicios Ofrecidos: ${specialties.length > 0 ? specialties.join(', ') : 'Servicios Generales'}
- Página Web del Negocio: ${website || 'No especificada'}`;

      let attemptData: any = {
        business_name: businessName,
        email: email,
        phone_number: phone || null,
        specialties: specialties,
        business_sector: sector || 'general',
        subscription_status: 'trial',
        subscription_plan: baseTenant 
          ? `Demo Autogenerada (Clon de ${baseTenant.business_name})`
          : 'Plan Demo Autogenerado',
        price_amount: 0,
        admin_pin: '12345678',
        billing_cycle: 'monthly',
        business_description: businessDescription,
        pricing_details: pricingDetails,
        custom_instructions: customInstructions,
        working_hours: workingHours,
        voice_id: voiceId,
        voice_speed: voiceSpeed,
        voice_temperature: voiceTemperature,
        voice_responsiveness: voiceResponsiveness,
        legal_address: address || null,
        knowledge_base_url: website || null,
        knowledge_base_content: kbContent,
        whatsapp_reminders_enabled: baseTenant ? !!baseTenant.whatsapp_reminders_enabled : false,
        email_notifications_enabled: baseTenant ? !!baseTenant.email_notifications_enabled : false,
        client_whatsapp_provider: baseTenant ? baseTenant.client_whatsapp_provider : null,
        twilio_account_sid: baseTenant ? baseTenant.twilio_account_sid : null,
        twilio_auth_token: baseTenant ? baseTenant.twilio_auth_token : null,
        twilio_whatsapp_number: baseTenant ? baseTenant.twilio_whatsapp_number : null,
        whatsapp_immediate_notification_enabled: baseTenant ? !!baseTenant.whatsapp_immediate_notification_enabled : false,
        whatsapp_reminder_hours: baseTenant ? baseTenant.whatsapp_reminder_hours : 24
      };

      let retries = 10;
      let newTenant: any = null;
      let tenantErr: any = null;

      while (retries > 0) {
        const result = await supabase
          .from('tenants')
          .insert(attemptData)
          .select('*')
          .single();

        if (result.error) {
          tenantErr = result.error;
          const errMsg = result.error.message || '';
          if (errMsg.includes('column') && retries > 1) {
            const match = errMsg.match(/['"]([^'"]+)['"]/);
            if (match && match[1]) {
              const colName = match[1];
              console.warn(`[Pipeline Fallback] Columna faltante detectada en demo insert: ${colName}. Eliminando y reintentando...`);
              delete attemptData[colName];
              retries--;
              continue;
            }
          }
          break;
        }

        newTenant = result.data;
        tenantErr = null;
        break;
      }

      if (tenantErr || !newTenant) {
        throw new Error(`Fallo al crear el tenant de demo: ${tenantErr?.message}`);
      }

      tenantId = newTenant.id;
      demoUrl = `${origin}/?tenant_id=${newTenant.id}`;

      // Aprovisionar LLM y Agente dedicados en Retell AI de forma asíncrona pero bloqueando este paso del pipeline
      let webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
      if (!webhookBaseUrl) {
        webhookBaseUrl = origin;
      }
      
      console.log(`[Pipeline] [Retell AI] Aprovisionando agente dedicado para ${businessName} (Webhook Base: ${webhookBaseUrl})...`);
      const retellAgentId = await createRetellAgentForTenant(newTenant, webhookBaseUrl);

      // Guardar el retell_agent_id en el tenant
      await supabase
        .from('tenants')
        .update({ retell_agent_id: retellAgentId })
        .eq('id', newTenant.id);

      // Actualizar prospecto en base de datos
      await supabase
        .from('prospects')
        .update({
          demo_tenant_id: tenantId,
          demo_url: demoUrl,
          status: 'demo_created'
        })
        .eq('id', prospectId);
        
      console.log(`[Pipeline] [Paso 1 Completado] Tenant Demo Creado e Integrado en Retell AI con ID: ${tenantId}`);
    }

    // 4. Generar Audio TTS Personalizado con Cartesia
    console.log(`[Pipeline] [Paso 2] Generando Audio de Presentación en Cartesia...`);
    let audioUrl = prospect.audio_url;

    // Si hay un override, forzamos la regeneración del audio para que coincida el nuevo nombre comercial
    if (!audioUrl || overrideData) {
      audioUrl = await generateCartesiaAudio(businessName, demoUrl || '');
      
      // Actualizar prospecto
      await supabase
        .from('prospects')
        .update({
          audio_url: audioUrl,
          status: 'audio_generated'
        })
        .eq('id', prospectId);
        
      console.log(`[Pipeline] [Paso 2 Completado] Audio generado y guardado en: ${audioUrl}`);
    }

    // 5. Enviar Correo de Outreach con Resend
    console.log(`[Pipeline] [Paso 3] Enviando correo electrónico de captación...`);
    
    if (!email || email.includes('example.com')) {
      throw new Error(`Email del prospecto inválido o no suministrado: ${email}`);
    }

    let voiceId = 'cefcb124-080b-4655-b31f-932f3ee743de';
    if (tenantId) {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('voice_id')
        .eq('id', tenantId)
        .maybeSingle();
      if (tenant?.voice_id) {
        voiceId = tenant.voice_id;
      }
    }

    const emailSent = await sendOutreachEmail({
      prospectId: prospectId,
      originUrl: origin,
      businessName: businessName,
      toEmail: email,
      demoUrl: demoUrl || '',
      audioUrl: audioUrl || '',
      sector: sector,
      voiceId: voiceId
    });

    if (!emailSent) {
      throw new Error('Fallo al enviar el correo a través del proveedor de email.');
    }

    // Pipeline Completado con éxito
    await supabase
      .from('prospects')
      .update({
        status: 'email_sent',
        error_details: null
      })
      .eq('id', prospectId);

    console.log(`[Pipeline] 🎉 ¡Pipeline completado con éxito para ${businessName}!`);
  } catch (err: any) {
    console.error(`[Pipeline ERROR] Fallo en el flujo del prospecto ${prospectId}:`, err.message);
    
    // Marcar prospecto como fallido y guardar error
    await supabase
      .from('prospects')
      .update({
        status: 'failed',
        error_details: err.message
      })
      .eq('id', prospectId);
  }
}

/**
 * Llama a la API de Cartesia para generar el audio MP3 y subirlo al Storage de Supabase
 */
async function generateCartesiaAudio(
  businessName: string,
  demoUrl: string,
  voiceId?: string,
  customScript?: string
): Promise<string> {
  const cartesiaKey = await getSettingVal('CARTESIA_API_KEY');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!cartesiaKey) {
    // Si no hay key de Cartesia, usamos un audio de plantilla de prueba para no bloquear el flujo
    console.log('[Cartesia Service] CARTESIA_API_KEY no configurada. Usando audio de fallback de Gabriela...');
    return `${supabaseUrl}/storage/v1/object/public/public-assets/gabriela_spanish.mp3`;
  }

  // Si no se suministra una voz, usamos por defecto la de Elena (España - Femenino)
  const finalVoiceId = voiceId || 'cefcb124-080b-4655-b31f-932f3ee743de';
  
  // Si no se suministra un guion, usamos el guion dinámico premium por defecto
  const finalScript = customScript || `Hola, muy buenas. Desde Corándar hemos diseñado un asistente de voz inteligente a medida para su negocio, ${businessName}. Este asistente ya está listo para atender sus llamadas, resolver dudas de sus clientes y gestionar sus citas las veinticuatro horas del día. Además, contará con un período de prueba totalmente gratuito de siete días. Le hemos preparado una simulación de llamada real en su panel de cliente, y puede consultar más información sobre nosotros en la web de Corándar. Acceda hoy mismo utilizando el enlace de este correo y su contraseña temporal: uno dos tres cuatro cinco seis siete ocho. También le invitamos a probar nuestra calculadora de ROI integrada en su panel, con la que podrá estimar el ahorro mensual y las citas que recuperará con Receptia. ¡Esperamos que le guste!`;

  try {
    const response = await axios.post(
      'https://api.cartesia.ai/tts/bytes',
      {
        model_id: 'sonic-3.5',
        transcript: finalScript,
        voice: {
          mode: 'id',
          id: finalVoiceId
        },
        output_format: {
          container: 'mp3',
          sample_rate: 44100
        }
      },
      {
        headers: {
          'Cartesia-Version': '2024-06-18',
          'X-API-Key': cartesiaKey,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 15000
      }
    );

    // Subir el audio a Supabase Storage
    const fileName = `demo-audios/${Date.now()}_${businessName.replace(/[^a-z0-9]/gi, '_')}.mp3`;
    const uploadUrl = `${supabaseUrl}/storage/v1/object/public-assets/${fileName}`;

    console.log(`[Cartesia Service] Subiendo audio generado a Supabase Storage: ${uploadUrl}...`);
    
    // Petición HTTP directa para subir al storage de Supabase (eludiendo las RLS con la key de service_role)
    await axios.post(
      `${supabaseUrl}/storage/v1/object/public-assets/${fileName}`,
      response.data,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'audio/mpeg'
        }
      }
    );

    const publicAudioUrl = `${supabaseUrl}/storage/v1/object/public/public-assets/${fileName}`;
    return publicAudioUrl;
  } catch (error: any) {
    let errorDetail = error.message;
    if (error.response && error.response.data) {
      try {
        const rawData = error.response.data;
        let dataStr = '';

        if (Buffer.isBuffer(rawData) || rawData instanceof ArrayBuffer) {
          dataStr = Buffer.from(rawData as any).toString('utf-8');
        } else if (typeof rawData === 'string') {
          dataStr = rawData;
        } else if (typeof rawData === 'object') {
          dataStr = JSON.stringify(rawData);
        } else {
          dataStr = String(rawData);
        }

        try {
          const parsed = JSON.parse(dataStr);
          errorDetail = parsed.message || parsed.error || parsed.error_description || dataStr;
        } catch {
          errorDetail = dataStr || error.message;
        }
      } catch (e: any) {
        errorDetail = `${error.message} (Failed to parse response: ${e.message})`;
      }
    }
    console.error('[Cartesia Service ERROR] Error al generar audio de Cartesia:', errorDetail);
    throw new Error(`Error en Cartesia TTS: ${errorDetail}`);
  }
}

/**
 * 4. Actualizar asignación de comercial masiva (bulk assign)
 */
router.patch('/assign-bulk', async (req: Request, res: Response): Promise<void> => {
  const { ids, comercial_id } = req.body;

  if (!ids || !Array.isArray(ids)) {
    res.status(400).json({ error: 'Se requiere un array de ids.' });
    return;
  }

  try {
    const { data, error } = await supabase
      .from('prospects')
      .update({ commercial_agent_id: comercial_id || null })
      .in('id', ids)
      .select('*');

    if (error) throw error;

    res.json({ status: 'success', count: data?.length || 0 });
  } catch (error: any) {
    console.error('[Prospecting API] Error en asignación masiva:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 4. Actualizar campos de un prospecto (por ejemplo, clasificación o estado)
 */
router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const updates = req.body;

  if (updates.classification === 'contratado') {
    res.status(400).json({ error: 'El estado Contratado se activa automáticamente al realizar el pago.' });
    return;
  }

  const mappedUpdates = { ...updates };
  if (updates.comercial_id !== undefined) {
    mappedUpdates.commercial_agent_id = updates.comercial_id;
    delete mappedUpdates.comercial_id;
  }

  try {
    const { data, error } = await supabase
      .from('prospects')
      .update(mappedUpdates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;
    
    const mapped = data ? { ...data, comercial_id: data.commercial_agent_id } : null;
    res.json({ status: 'success', prospect: mapped });
  } catch (error: any) {
    console.error('[Prospecting API] Error al actualizar prospecto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 5. Eliminar un prospecto y opcionalmente su tenant demo
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    // 1. Obtener demo_tenant_id para ver si hay que borrar el tenant
    const { data: prospect, error: fetchErr } = await supabase
      .from('prospects')
      .select('demo_tenant_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;

    // 2. Si tiene tenant de demo, eliminarlo de la tabla tenants y borrar de Retell AI (solo si no tiene contrato ni suscripción)
    if (prospect && prospect.demo_tenant_id) {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('retell_agent_id, signed_contract_content, stripe_subscription_id')
        .eq('id', prospect.demo_tenant_id)
        .maybeSingle();

      if (tenant) {
        const hasContractOrSub = 
          (tenant.signed_contract_content && tenant.signed_contract_content.trim() !== '') || 
          (tenant.stripe_subscription_id && tenant.stripe_subscription_id.trim() !== '');

        if (!hasContractOrSub) {
          console.log(`[Prospecting API] Eliminando tenant demo ${prospect.demo_tenant_id} asociado al prospecto ${id} porque no cuenta con contrato ni suscripción activa.`);
          if (tenant.retell_agent_id) {
            await deleteRetellAgent(tenant.retell_agent_id);
          }
          await supabase
            .from('tenants')
            .delete()
            .eq('id', prospect.demo_tenant_id);
        } else {
          console.log(`[Prospecting API] Preservando tenant ${prospect.demo_tenant_id} asociado al prospecto ${id} por contar con contrato o suscripción activa.`);
        }
      }
    }

    // 3. Eliminar el prospecto
    const { error: deleteErr } = await supabase
      .from('prospects')
      .delete()
      .eq('id', id);

    if (deleteErr) throw deleteErr;

    res.json({ status: 'success', message: 'Prospecto y recursos asociados eliminados correctamente.' });
  } catch (error: any) {
    console.error('[Prospecting API] Error al eliminar prospecto:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 6. Eliminar múltiples prospectos (bulk delete)
 */
router.post('/delete-bulk', async (req: Request, res: Response): Promise<void> => {
  const { ids } = req.body;

  if (!ids || !Array.isArray(ids)) {
    res.status(400).json({ error: 'Se requiere un array de ids.' });
    return;
  }

  try {
    // 1. Obtener los demo_tenant_ids para borrarlos también
    const { data: prospects, error: fetchErr } = await supabase
      .from('prospects')
      .select('demo_tenant_id')
      .in('id', ids);

    if (fetchErr) throw fetchErr;

    const tenantIds = prospects
      ? prospects.map((p: any) => p.demo_tenant_id).filter((id: any) => !!id)
      : [];

    // 2. Borrar los tenants demo y sus agentes en Retell AI (solo si no tienen contrato ni suscripción)
    if (tenantIds.length > 0) {
      const { data: tenants } = await supabase
        .from('tenants')
        .select('id, retell_agent_id, signed_contract_content, stripe_subscription_id')
        .in('id', tenantIds);

      if (tenants) {
        const tenantsToDelete: string[] = [];
        for (const tenant of tenants) {
          const hasContractOrSub = 
            (tenant.signed_contract_content && tenant.signed_contract_content.trim() !== '') || 
            (tenant.stripe_subscription_id && tenant.stripe_subscription_id.trim() !== '');

          if (!hasContractOrSub) {
            tenantsToDelete.push(tenant.id);
            if (tenant.retell_agent_id) {
              await deleteRetellAgent(tenant.retell_agent_id);
            }
          } else {
            console.log(`[Prospecting API] Preservando tenant ${tenant.id} durante borrado masivo por contar con contrato o suscripción activa.`);
          }
        }

        if (tenantsToDelete.length > 0) {
          await supabase
            .from('tenants')
            .delete()
            .in('id', tenantsToDelete);
        }
      }
    }

    // 3. Borrar los prospectos
    const { error: deleteErr } = await supabase
      .from('prospects')
      .delete()
      .in('id', ids);

    if (deleteErr) throw deleteErr;

    res.json({ status: 'success', message: `Se han eliminado ${ids.length} prospectos y sus recursos asociados.` });
  } catch (error: any) {
    console.error('[Prospecting API] Error en eliminación masiva:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 7. Reenviar correo electrónico de captación (Outreach) para un prospecto existente
 */
router.post('/:id/resend-email', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { subject, body, to_email_override } = req.body;

  try {
    const { data: prospect, error: fetchErr } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !prospect) {
      res.status(404).json({ error: `No se pudo encontrar el prospecto con ID: ${id}` });
      return;
    }

    // Guardar subject en settings si viene en la petición
    if (subject !== undefined) {
      const key = `outreach_subject_${id}`;
      const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
      if (existing) {
        await supabase.from('settings').update({ value: subject }).eq('key', key);
      } else {
        await supabase.from('settings').insert({ key, value: subject });
      }
    }

    // Guardar body en settings si viene en la petición
    if (body !== undefined) {
      const key = `outreach_body_${id}`;
      const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
      if (existing) {
        await supabase.from('settings').update({ value: body }).eq('key', key);
      } else {
        await supabase.from('settings').insert({ key, value: body });
      }
    }

    let recipient = prospect.email;
    let isTest = false;

    if (to_email_override) {
      isTest = true;
      if (to_email_override === 'admin') {
        const adminEmail = await getSettingVal('ADMIN_TEST_EMAIL');
        if (!adminEmail) {
          res.status(400).json({ error: 'No se ha configurado el "Correo de Prueba del Administrador" en los Ajustes.' });
          return;
        }
        recipient = adminEmail;
      } else {
        recipient = to_email_override;
      }
    }

    if (!recipient || recipient.includes('example.com')) {
      res.status(400).json({ error: `El correo electrónico de destino no es válido: ${recipient}` });
      return;
    }

    if (!prospect.demo_url || !prospect.audio_url) {
      res.status(400).json({ error: 'El prospecto debe tener una demo y un audio generados antes de enviar el correo.' });
      return;
    }

    const emailSubject = subject || `🎙️ Hemos diseñado un Asistente de Voz IA para ${prospect.business_name}`;
    const webhookBase = (await getSettingVal('WEBHOOK_BASE_URL') || (req.protocol + '://' + req.get('host'))) as string;

    let voiceId = 'cefcb124-080b-4655-b31f-932f3ee743de';
    if (prospect.demo_tenant_id) {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('voice_id')
        .eq('id', prospect.demo_tenant_id)
        .maybeSingle();
      if (tenant?.voice_id) {
        voiceId = tenant.voice_id;
      }
    }

    const htmlKey = `outreach_html_${id}`;
    const { data: htmlVal } = await supabase.from('settings').select('value').eq('key', htmlKey).maybeSingle();

    console.log(`[Prospecting API] Enviando correo de outreach para ${prospect.business_name} (Test: ${isTest}) a ${recipient}...`);
    const emailSent = await sendOutreachEmail({
      prospectId: isTest ? undefined : (id as string),
      originUrl: isTest ? undefined : (webhookBase as string),
      businessName: prospect.business_name,
      toEmail: recipient as string,
      demoUrl: prospect.demo_url,
      audioUrl: prospect.audio_url,
      sector: prospect.sector || 'general',
      subject: emailSubject,
      bodyOverride: body,
      voiceId: voiceId,
      htmlOverride: htmlVal?.value
    });

    if (!emailSent) {
      throw new Error('Fallo al enviar el correo a través del proveedor de email.');
    }

    if (!isTest) {
      // Actualizar el estado por si acaso estaba en failed o borrador
      await supabase
        .from('prospects')
        .update({
          status: 'email_sent',
          error_details: null
        })
        .eq('id', id);
    }

    res.json({
      status: 'success',
      message: isTest
        ? `Correo de prueba enviado con éxito a la dirección del administrador: ${recipient}`
        : `Correo enviado con éxito al prospecto: ${recipient}`
    });
  } catch (err: any) {
    console.error(`[Prospecting API ERROR] Fallo al enviar correo para prospecto ${id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 8. Obtener vista previa del correo de captación (HTML)
 */
router.get('/:id/preview-email', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const { data: prospect, error: fetchErr } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !prospect) {
      res.status(404).json({ error: `No se pudo encontrar el prospecto con ID: ${id}` });
      return;
    }

    const voiceKey = `outreach_voice_${id}`;
    const scriptKey = `outreach_script_${id}`;
    const subjectKey = `outreach_subject_${id}`;
    const bodyKey = `outreach_body_${id}`;

    // Obtener valores personalizados guardados en settings
    const { data: voiceVal } = await supabase.from('settings').select('value').eq('key', voiceKey).maybeSingle();
    const { data: scriptVal } = await supabase.from('settings').select('value').eq('key', scriptKey).maybeSingle();
    const { data: subjectVal } = await supabase.from('settings').select('value').eq('key', subjectKey).maybeSingle();
    const { data: bodyVal } = await supabase.from('settings').select('value').eq('key', bodyKey).maybeSingle();

    const selectedVoiceId = voiceVal?.value || 'cefcb124-080b-4655-b31f-932f3ee743de'; // Elena por defecto
    const defaultScriptText = `Hola, muy buenas. Desde Corándar hemos diseñado un asistente de voz inteligente a medida para su negocio, ${prospect.business_name}. Este asistente ya está listo para atender sus llamadas, resolver dudas de sus clientes y gestionar sus citas las veinticuatro horas del día. Además, contará con un período de prueba totalmente gratuito de siete días. Le hemos preparado una simulación de llamada real en su panel de cliente, y puede consultar más información sobre nosotros en la web de Corándar. Acceda hoy mismo utilizando el enlace de este correo y su contraseña temporal: uno dos tres cuatro cinco seis siete ocho. También le invitamos a probar nuestra calculadora de ROI integrada en su panel, con la que podrá estimar el ahorro mensual y las citas que recuperará con Receptia. ¡Esperamos que le guste!`;
    const selectedScript = scriptVal?.value || defaultScriptText;

    const defaultSubject = `🎙️ Corándar ha diseñado un Asistente de Voz IA para ${prospect.business_name}`;
    const defaultBodyText = `Estimado/a responsable de ${prospect.business_name},

Desde Corándar hemos diseñado y configurado un Agente de Voz con Inteligencia Artificial adaptado a las necesidades específicas de su negocio.

Este agente es capaz de atender llamadas telefónicas las 24 horas del día, responder consultas detalladas sobre sus servicios, y agendar citas de forma completamente autónoma directamente en su calendario.`;

    const htmlKey = `outreach_html_${id}`;
    const { data: htmlVal } = await supabase.from('settings').select('value').eq('key', htmlKey).maybeSingle();

    const selectedSubject = subjectVal?.value || defaultSubject;
    const selectedBody = bodyVal?.value || defaultBodyText;

    let htmlContent = htmlVal?.value;
    if (!htmlContent) {
      htmlContent = getOutreachEmailTemplate(
        prospect.business_name,
        prospect.demo_url || '#',
        prospect.audio_url || '#',
        prospect.sector || 'general',
        selectedBody,
        selectedVoiceId
      );
    }

    res.json({
      status: 'success',
      subject: selectedSubject,
      body: selectedBody,
      to: prospect.email,
      html: htmlContent,
      voice_id: selectedVoiceId,
      script: selectedScript,
      business_name: prospect.business_name
    });
  } catch (err: any) {
    console.error(`[Prospecting API ERROR] Fallo al obtener vista previa para prospecto ${id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 8.5. Guardar ajustes personalizados de outreach sin regenerar el audio de demo
 */
router.post('/:id/save-outreach-settings', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { subject, body, voice_id, script, html, business_name } = req.body;

  try {
    if (business_name !== undefined && business_name.trim() !== '') {
      await supabase
        .from('prospects')
        .update({ business_name: business_name.trim() })
        .eq('id', id);
    }

    const { data: prospect, error: fetchErr } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !prospect) {
      res.status(404).json({ error: `No se pudo encontrar el prospecto con ID: ${id}` });
      return;
    }

    // Guardar Asunto
    if (subject !== undefined) {
      const key = `outreach_subject_${id}`;
      const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
      if (existing) {
        await supabase.from('settings').update({ value: subject }).eq('key', key);
      } else {
        await supabase.from('settings').insert({ key, value: subject });
      }
    }

    // Guardar Cuerpo
    if (body !== undefined) {
      const key = `outreach_body_${id}`;
      const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
      if (existing) {
        await supabase.from('settings').update({ value: body }).eq('key', key);
      } else {
        await supabase.from('settings').insert({ key, value: body });
      }
    }

    // Guardar Voz
    if (voice_id !== undefined) {
      const key = `outreach_voice_${id}`;
      const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
      if (existing) {
        await supabase.from('settings').update({ value: voice_id }).eq('key', key);
      } else {
        await supabase.from('settings').insert({ key, value: voice_id });
      }
    }

    // Guardar Script/Guion
    if (script !== undefined) {
      const key = `outreach_script_${id}`;
      const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
      if (existing) {
        await supabase.from('settings').update({ value: script }).eq('key', key);
      } else {
        await supabase.from('settings').insert({ key, value: script });
      }
    }

    // Guardar HTML personalizado
    if (html !== undefined) {
      const key = `outreach_html_${id}`;
      const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
      if (existing) {
        await supabase.from('settings').update({ value: html }).eq('key', key);
      } else {
        await supabase.from('settings').insert({ key, value: html });
      }
    }

    // Obtener la vista previa actualizada del correo (respetando HTML personalizado)
    const htmlKey = `outreach_html_${id}`;
    const { data: htmlVal } = await supabase.from('settings').select('value').eq('key', htmlKey).maybeSingle();
    
    let htmlContent = htmlVal?.value;
    if (!htmlContent) {
      htmlContent = getOutreachEmailTemplate(
        prospect.business_name,
        prospect.demo_url || '#',
        prospect.audio_url || '#',
        prospect.sector || 'general',
        body,
        voice_id
      );
    }

    res.json({
      status: 'success',
      html: htmlContent,
      business_name: prospect.business_name
    });
  } catch (err: any) {
    console.error(`[Prospecting API ERROR] Fallo al guardar ajustes de outreach para prospecto ${id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 9. Regenerar la alocución de audio (TTS) con voz/guion personalizados
 */
router.post('/:id/regenerate-audio', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { voice_id, script, subject, body, business_name } = req.body;

  try {
    if (business_name !== undefined && business_name.trim() !== '') {
      await supabase
        .from('prospects')
        .update({ business_name: business_name.trim() })
        .eq('id', id);
    }

    const { data: prospect, error: fetchErr } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !prospect) {
      res.status(404).json({ error: `No se pudo encontrar el prospecto con ID: ${id}` });
      return;
    }

    if (!prospect.demo_url) {
      res.status(400).json({ error: 'El prospecto debe tener una demo creada antes de generar su alocución.' });
      return;
    }

    console.log(`[Prospecting API] Regenerando alocución de audio para ${prospect.business_name} con voz ${voice_id}...`);
    
    // Generar el audio usando Cartesia
    const audioUrl = await generateCartesiaAudio(prospect.business_name, prospect.demo_url, voice_id, script);

    // Guardar en la tabla settings el script y la voz para este prospecto
    const voiceKey = `outreach_voice_${id}`;
    const scriptKey = `outreach_script_${id}`;
    const subjectKey = `outreach_subject_${id}`;
    const bodyKey = `outreach_body_${id}`;

    // Upsert para la voz
    const { data: existingVoice } = await supabase
      .from('settings')
      .select('value')
      .eq('key', voiceKey)
      .maybeSingle();

    if (existingVoice) {
      await supabase.from('settings').update({ value: voice_id }).eq('key', voiceKey);
    } else {
      await supabase.from('settings').insert({ key: voiceKey, value: voice_id });
    }

    // Upsert para el script
    const { data: existingScript } = await supabase
      .from('settings')
      .select('value')
      .eq('key', scriptKey)
      .maybeSingle();

    if (existingScript) {
      await supabase.from('settings').update({ value: script }).eq('key', scriptKey);
    } else {
      await supabase.from('settings').insert({ key: scriptKey, value: script });
    }

    // Upsert para Asunto si viene en la petición
    if (subject !== undefined) {
      const { data: existingSub } = await supabase
        .from('settings')
        .select('value')
        .eq('key', subjectKey)
        .maybeSingle();

      if (existingSub) {
        await supabase.from('settings').update({ value: subject }).eq('key', subjectKey);
      } else {
        await supabase.from('settings').insert({ key: subjectKey, value: subject });
      }
    }

    // Upsert para Cuerpo si viene en la petición
    if (body !== undefined) {
      const { data: existingBody } = await supabase
        .from('settings')
        .select('value')
        .eq('key', bodyKey)
        .maybeSingle();

      if (existingBody) {
        await supabase.from('settings').update({ value: body }).eq('key', bodyKey);
      } else {
        await supabase.from('settings').insert({ key: bodyKey, value: body });
      }
    }

    // Actualizar la URL de audio en el prospecto
    await supabase
      .from('prospects')
      .update({ audio_url: audioUrl })
      .eq('id', id);

    // Obtener la nueva vista previa del HTML del correo con el nuevo reproductor de audio y el cuerpo
    const htmlKey = `outreach_html_${id}`;
    const { data: htmlVal } = await supabase.from('settings').select('value').eq('key', htmlKey).maybeSingle();
    let htmlContent = htmlVal?.value;

    if (htmlContent) {
      if (prospect.audio_url) {
        htmlContent = htmlContent.replaceAll(prospect.audio_url, audioUrl);
        await supabase.from('settings').update({ value: htmlContent }).eq('key', htmlKey);
      }
    } else {
      htmlContent = getOutreachEmailTemplate(
        prospect.business_name,
        prospect.demo_url,
        audioUrl,
        prospect.sector || 'general',
        body,
        voice_id
      );
    }

    res.json({
      status: 'success',
      audioUrl: audioUrl,
      html: htmlContent
    });
  } catch (err: any) {
    console.error(`[Prospecting API ERROR] Fallo al regenerar audio de captación para prospecto ${id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 8.6. Restablecer HTML de outreach por defecto (elimina la personalización)
 */
router.post('/:id/reset-outreach-html', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    const key = `outreach_html_${id}`;
    await supabase.from('settings').delete().eq('key', key);

    const { data: prospect, error: fetchErr } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !prospect) {
      res.status(404).json({ error: `No se pudo encontrar el prospecto con ID: ${id}` });
      return;
    }

    const bodyKey = `outreach_body_${id}`;
    const voiceKey = `outreach_voice_${id}`;
    const { data: bodyVal } = await supabase.from('settings').select('value').eq('key', bodyKey).maybeSingle();
    const { data: voiceVal } = await supabase.from('settings').select('value').eq('key', voiceKey).maybeSingle();

    const selectedVoiceId = voiceVal?.value || 'cefcb124-080b-4655-b31f-932f3ee743de';
    const defaultBodyText = `Estimado/a responsable de ${prospect.business_name},\n\nDesde Corándar hemos diseñado y configurado un Agente de Voz con Inteligencia Artificial adaptado a las necesidades específicas de su negocio.\n\nEste agente es capaz de atender llamadas telefónicas las 24 horas del día, responder consultas detalladas sobre sus servicios, y agendar citas de forma completamente autónoma directamente en su calendario.`;
    const selectedBody = bodyVal?.value || defaultBodyText;

    const htmlContent = getOutreachEmailTemplate(
      prospect.business_name,
      prospect.demo_url || '#',
      prospect.audio_url || '#',
      prospect.sector || 'general',
      selectedBody,
      selectedVoiceId
    );

    res.json({
      status: 'success',
      html: htmlContent,
      business_name: prospect.business_name
    });
  } catch (err: any) {
    console.error(`[Prospecting API ERROR] Fallo al restablecer html para prospecto ${id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
