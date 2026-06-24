import { Router, Request, Response } from 'express';
import { supabase, getSettingVal } from '../services/supabase';
import { scrapeProspects } from '../services/scraper';
import { sendOutreachEmail } from '../services/outreach';
import axios from 'axios';

const router = Router();

/**
 * 1. Obtener todos los prospectos guardados
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('prospects')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ prospects: data || [] });
  } catch (error: any) {
    console.error('[Prospecting API] Error al obtener prospectos:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 2. Buscar y extraer prospectos de Google Maps y scraping web
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

    // Guardar leads en Supabase
    for (const lead of leads) {
      // Evitar duplicados basados en email o nombre de negocio + dirección
      const { data: existing } = await supabase
        .from('prospects')
        .select('id')
        .eq('business_name', lead.business_name)
        .eq('address', lead.address)
        .maybeSingle();

      if (existing) {
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
          status: 'extracted'
        })
        .select('*')
        .single();

      if (error) {
        console.error('[Prospecting API] Error al guardar lead:', error.message);
      } else if (data) {
        insertedProspects.push(data);
      }
    }

    res.json({
      status: 'success',
      message: `Se han extraído e insertado ${insertedProspects.length} nuevos leads con éxito.`,
      prospects: insertedProspects
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
  const { prospect_id } = req.body;

  if (!prospect_id) {
    res.status(400).json({ error: 'El prospect_id es obligatorio.' });
    return;
  }

  // Responder inmediatamente de forma asíncrona para no congelar el servidor
  res.json({ status: 'processing', message: 'El pipeline de demostración se ha iniciado en segundo plano.' });

  // Ejecutar el pipeline de forma asíncrona
  runOutreachPipeline(prospect_id, req.headers.origin || 'https://receptia.corandar.com').catch(err => {
    console.error(`[Pipeline Error Critical] Error general en el pipeline del prospecto ${prospect_id}:`, err.message);
  });
});

/**
 * Función que orquesta todo el flujo asíncrono del pipeline
 */
async function runOutreachPipeline(prospectId: string, origin: string) {
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

    // 2. Crear Tenant Demo en la base de datos
    console.log(`[Pipeline] [Paso 1] Creando Tenant Demo para: ${prospect.business_name}...`);
    
    // Si ya tiene un tenant demo creado de antes, lo reutilizamos
    let tenantId = prospect.demo_tenant_id;
    let demoUrl = prospect.demo_url;

    if (!tenantId) {
      const { data: newTenant, error: tenantErr } = await supabase
        .from('tenants')
        .insert({
          business_name: prospect.business_name,
          email: prospect.email || `contacto@${prospect.business_name.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
          phone_number: null, // Sin número asignado al inicio
          specialties: prospect.specialties || [],
          subscription_status: 'trial',
          subscription_plan: 'Plan Demo Autogenerado',
          price_amount: 0,
          billing_cycle: 'monthly',
          business_description: `Demostración de asistente de voz autogenerada para ${prospect.business_name}.`,
          custom_instructions: `Eres Elena, la asistente virtual de ${prospect.business_name}. Saluda amablemente, responde preguntas basadas en el negocio, y ofrece al interlocutor registrar una cita de prueba de forma natural y educada.`,
          working_hours: {
            lunes: [{ start: '09:00', end: '19:00' }],
            martes: [{ start: '09:00', end: '19:00' }],
            miercoles: [{ start: '09:00', end: '19:00' }],
            jueves: [{ start: '09:00', end: '19:00' }],
            viernes: [{ start: '09:00', end: '19:00' }]
          },
          voice_id: 'cartesia-Sofia',
          voice_speed: 1.0,
          voice_temperature: 1.0,
          voice_responsiveness: 1.0
        })
        .select('*')
        .single();

      if (tenantErr || !newTenant) {
        throw new Error(`Fallo al crear el tenant de demo: ${tenantErr?.message}`);
      }

      tenantId = newTenant.id;
      demoUrl = `${origin}/?tenant_id=${newTenant.id}`;

      // Actualizar prospecto en base de datos
      await supabase
        .from('prospects')
        .update({
          demo_tenant_id: tenantId,
          demo_url: demoUrl,
          status: 'demo_created'
        })
        .eq('id', prospectId);
        
      console.log(`[Pipeline] [Paso 1 Completado] Tenant Demo Creado con ID: ${tenantId}`);
    }

    // 3. Generar Audio TTS Personalizado con Cartesia
    console.log(`[Pipeline] [Paso 2] Generando Audio de Presentación en Cartesia...`);
    let audioUrl = prospect.audio_url;

    if (!audioUrl) {
      audioUrl = await generateCartesiaAudio(prospect.business_name, demoUrl || '');
      
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

    // 4. Enviar Correo de Outreach con Resend
    console.log(`[Pipeline] [Paso 3] Enviando correo electrónico de captación...`);
    
    if (!prospect.email || prospect.email.includes('example.com')) {
      throw new Error(`Email del prospecto inválido o no suministrado: ${prospect.email}`);
    }

    const emailSent = await sendOutreachEmail({
      businessName: prospect.business_name,
      toEmail: prospect.email,
      demoUrl: demoUrl || '',
      audioUrl: audioUrl || '',
      sector: prospect.sector
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

    console.log(`[Pipeline] 🎉 ¡Pipeline completado con éxito para ${prospect.business_name}!`);
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
async function generateCartesiaAudio(businessName: string, demoUrl: string): Promise<string> {
  const cartesiaKey = await getSettingVal('CARTESIA_API_KEY');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!cartesiaKey) {
    // Si no hay key de Cartesia, usamos un audio de plantilla de prueba para no bloquear el flujo
    console.log('[Cartesia Service] CARTESIA_API_KEY no configurada. Usando audio de fallback de Gabriela...');
    return `${supabaseUrl}/storage/v1/object/public/public-assets/gabriela_spanish.mp3`;
  }

  // Script dinámico personalizado en español
  const transcript = `Hola, buenas. Soy la asistente virtual inteligente de ${businessName}. He sido diseñada específicamente para atender las llamadas de su negocio las 24 horas del día, resolver dudas de clientes y gestionar su agenda. Le he preparado un panel de demostración privado para que pueda ver cómo funciona en tiempo real. Acceda al enlace de su panel en este correo.`;

  try {
    const response = await axios.post(
      'https://api.cartesia.ai/tts/bytes',
      {
        model_id: 'sonic-multilingual',
        transcript: transcript,
        voice: {
          mode: 'id',
          id: 'a0e716df-59a4-44b2-a400-343048995c7b' // Voz Sofia/Gabriela en español
        },
        output_format: {
          container: 'mp3',
          sample_rate: 44100,
          encoding: 'mp3'
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
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'audio/mpeg'
        }
      }
    );

    const publicAudioUrl = `${supabaseUrl}/storage/v1/object/public/public-assets/${fileName}`;
    return publicAudioUrl;
  } catch (error: any) {
    console.error('[Cartesia Service ERROR] Error al generar audio de Cartesia:', error.response?.data || error.message);
    throw new Error(`Error en Cartesia TTS: ${error.message}`);
  }
}

/**
 * 4. Actualizar campos de un prospecto (por ejemplo, clasificación o estado)
 */
router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const updates = req.body;

  try {
    const { data, error } = await supabase
      .from('prospects')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;
    res.json({ status: 'success', prospect: data });
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

    // 2. Si tiene tenant de demo, eliminarlo de la tabla tenants
    if (prospect && prospect.demo_tenant_id) {
      await supabase
        .from('tenants')
        .delete()
        .eq('id', prospect.demo_tenant_id);
    }

    // 3. Eliminar el prospecto
    const { error: deleteErr } = await supabase
      .from('prospects')
      .delete()
      .eq('id', id);

    if (deleteErr) throw deleteErr;

    res.json({ status: 'success', message: 'Prospecto eliminado correctamente.' });
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

    // 2. Borrar los tenants demo
    if (tenantIds.length > 0) {
      await supabase
        .from('tenants')
        .delete()
        .in('id', tenantIds);
    }

    // 3. Borrar los prospectos
    const { error: deleteErr } = await supabase
      .from('prospects')
      .delete()
      .in('id', ids);

    if (deleteErr) throw deleteErr;

    res.json({ status: 'success', message: `Se han eliminado ${ids.length} prospectos.` });
  } catch (error: any) {
    console.error('[Prospecting API] Error en eliminación masiva:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
