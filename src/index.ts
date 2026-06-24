import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import webhookRouter from './routes/webhook';
import { getAuthUrl, getTokensFromCode, updateAppointment, deleteAppointment } from './services/googleCalendar';
import { supabase, getSettingVal } from './services/supabase';
import { syncTenantWithRetell, compileSystemPrompt, formatVoiceId, deleteRetellAgent, resolveAgentName } from './services/retell';
import { createStripeCheckoutSession, createStripePortalSession, getStripeClient } from './services/stripe';
import axios from 'axios';
import { sendWhatsAppMessage } from './services/whatsapp';
import { 
  initWhatsAppWebSession, 
  disconnectWhatsAppWebSession, 
  getWhatsAppSessionStatus, 
  autoStartActiveSessions,
  debugLogs
} from './services/whatsapp-web';

// Cargar variables de entorno
dotenv.config();

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// Middlewares
import path from 'path';

// Middlewares
app.use(cors());
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf;
  }
}));

// Servir archivos estáticos del panel de control
app.use(express.static(path.join(process.cwd(), 'public')));

// Endpoints REST de la Plataforma SaaS

// 1. Obtener detalles de un inquilino por email o ID, o listar todos si no se especifican filtros
app.get('/api/tenants', async (req, res): Promise<void> => {
  const { email, id } = req.query;
  try {
    let query = supabase.from('tenants').select('*');
    const mapTenant = (t: any) => {
      if (!t) return t;
      let workingHoursObj = t.working_hours;
      if (typeof workingHoursObj === 'string') {
        try { workingHoursObj = JSON.parse(workingHoursObj); } catch (e) {}
      }
      t.client_enable_multi_professional = workingHoursObj?.client_enable_multi_professional !== false;
      return t;
    };

    if (id) {
      const { data, error } = await query.eq('id', id).single();
      if (error || !data) {
        res.status(404).json({ error: 'Inquilino no encontrado.' });
        return;
      }
      res.json(mapTenant(data));
      return;
    } else if (email) {
      const { data, error } = await query.eq('email', email).single();
      if (error || !data) {
        res.status(404).json({ error: 'Inquilino no encontrado.' });
        return;
      }
      res.json(mapTenant(data));
      return;
    } else {
      // Listar todos los inquilinos activos (no archivados) para el panel de administración
      const { data, error } = await query
        .eq('is_archived', false)
        .order('business_name', { ascending: true });
      if (error) throw error;
      res.json((data || []).map(mapTenant));
      return;
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Registrar o actualizar un inquilino
app.post('/api/tenants', async (req, res): Promise<void> => {
  const { 
    business_name, 
    email, 
    specialties,
    voice_id,
    phone_number,
    business_description,
    pricing_details,
    custom_instructions,
    admin_pin,
    vacation_mode,
    vacation_message,
    voice_speed,
    voice_temperature,
    voice_responsiveness,
    whatsapp_reminder_hours,
    client_whatsapp_enabled,
    client_email_enabled,
    client_whatsapp_provider,
    twilio_account_sid,
    twilio_auth_token,
    twilio_whatsapp_number,
    client_enable_multi_professional,
    whatsapp_immediate_notification_enabled
  } = req.body;

  if (!business_name || !email) {
    res.status(400).json({ error: 'El nombre del negocio y el email son obligatorios.' });
    return;
  }
  
  try {
    // Buscar si ya existe por email
    const { data: existing } = await supabase
      .from('tenants')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    const formattedVoiceIdVal = formatVoiceId(voice_id);
    const tenantData: any = {};
    if (business_name !== undefined) tenantData.business_name = business_name;
    if (specialties !== undefined) tenantData.specialties = specialties;
    if (voice_id !== undefined) tenantData.voice_id = formattedVoiceIdVal;
    if (phone_number !== undefined) tenantData.phone_number = phone_number;
    if (business_description !== undefined) tenantData.business_description = business_description;
    if (pricing_details !== undefined) tenantData.pricing_details = pricing_details;
    if (custom_instructions !== undefined) tenantData.custom_instructions = custom_instructions;
    if (admin_pin !== undefined) tenantData.admin_pin = admin_pin;
    if (vacation_mode !== undefined) tenantData.vacation_mode = !!vacation_mode;
    if (vacation_message !== undefined) tenantData.vacation_message = vacation_message;
    if (voice_speed !== undefined) tenantData.voice_speed = Number(voice_speed);
    if (voice_temperature !== undefined) tenantData.voice_temperature = Number(voice_temperature);
    if (voice_responsiveness !== undefined) tenantData.voice_responsiveness = Number(voice_responsiveness);
    if (whatsapp_reminder_hours !== undefined) tenantData.whatsapp_reminder_hours = Number(whatsapp_reminder_hours);
    if (client_whatsapp_enabled !== undefined) tenantData.client_whatsapp_enabled = !!client_whatsapp_enabled;
    if (client_email_enabled !== undefined) tenantData.client_email_enabled = !!client_email_enabled;
    if (client_whatsapp_provider !== undefined) tenantData.client_whatsapp_provider = client_whatsapp_provider;
    if (twilio_account_sid !== undefined) tenantData.twilio_account_sid = twilio_account_sid;
    if (twilio_auth_token !== undefined) tenantData.twilio_auth_token = twilio_auth_token;
    if (twilio_whatsapp_number !== undefined) tenantData.twilio_whatsapp_number = twilio_whatsapp_number;
    if (whatsapp_immediate_notification_enabled !== undefined) tenantData.whatsapp_immediate_notification_enabled = !!whatsapp_immediate_notification_enabled;
    if (client_enable_multi_professional !== undefined) {
      let workingHoursObj: any = {};
      if (existing && existing.working_hours) {
        workingHoursObj = typeof existing.working_hours === 'string' 
          ? JSON.parse(existing.working_hours) 
          : existing.working_hours;
      }
      workingHoursObj.client_enable_multi_professional = !!client_enable_multi_professional;
      tenantData.working_hours = workingHoursObj;
    }

    let savedTenant: any;

    if (existing) {
      // Actualizar datos de negocio y especialidades
      let attemptData: any = { ...tenantData };
      let retries = 10;
      let success = false;
      let lastError: any = null;

      while (retries > 0 && !success) {
        const result = await supabase
          .from('tenants')
          .update(attemptData)
          .eq('id', existing.id)
          .select()
          .single();
        
        if (result.error) {
          lastError = result.error;
          const errMsg = result.error.message || '';
          if (errMsg.includes('column') && retries > 1) {
            const match = errMsg.match(/['"]([^'"]+)['"]/);
            if (match && match[1]) {
              const colName = match[1];
              console.warn(`[Supabase Fallback] Columna faltante detectada en client/settings (update): ${colName}. Eliminando y reintentando...`);
              delete attemptData[colName];
              retries--;
              continue;
            }
          }
          throw result.error;
        }
        
        savedTenant = result.data;
        success = true;
      }
      if (!success && lastError) throw lastError;

      // BUG-03: Si el proveedor de WhatsApp cambia de QR a cualquier otro (e.g. twilio), cerrar la sesión de WhatsApp Web activa en memoria
      if (existing.client_whatsapp_provider === 'qr' && savedTenant.client_whatsapp_provider !== 'qr') {
        console.log(`[WhatsApp Cleanup] El proveedor de WhatsApp cambió de QR a ${savedTenant.client_whatsapp_provider} para ${existing.id}. Cerrando sesión QR...`);
        disconnectWhatsAppWebSession(existing.id).catch(err => {
          console.error(`Error al desconectar sesión QR tras cambio de proveedor:`, err.message);
        });
      }
    } else {
      // Crear un nuevo registro
      let attemptData: any = { ...tenantData };
      let retries = 10;
      let success = false;
      let lastError: any = null;

      while (retries > 0 && !success) {
        const result = await supabase
          .from('tenants')
          .insert({ 
            ...attemptData,
            email, 
            retell_agent_id: process.env.RETELL_AGENT_ID // Vincular por defecto el agente de Retell activo
          })
          .select()
          .single();
        
        if (result.error) {
          lastError = result.error;
          const errMsg = result.error.message || '';
          if (errMsg.includes('column') && retries > 1) {
            const match = errMsg.match(/['"]([^'"]+)['"]/);
            if (match && match[1]) {
              const colName = match[1];
              console.warn(`[Supabase Fallback] Columna faltante detectada en client/settings (insert): ${colName}. Eliminando y reintentando...`);
              delete attemptData[colName];
              retries--;
              continue;
            }
          }
          throw result.error;
        }
        
        savedTenant = result.data;
        success = true;
      }
      if (!success && lastError) throw lastError;
    }

    // Sincronizar en segundo plano con Retell AI para no bloquear la respuesta HTTP
    let webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
    if (!webhookBaseUrl) {
      const host = req.get('host') || '';
      const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
      webhookBaseUrl = `${protocol}://${host}`;
    }
    syncTenantWithRetell(savedTenant, webhookBaseUrl)
      .then(() => console.log(`Sincronización completada con Retell AI para ${email}`))
      .catch(err => console.error(`Error en segundo plano al sincronizar ${email} con Retell AI:`, err.message));

    res.json(savedTenant);
  } catch (err: any) {
    console.error('Error al guardar inquilino:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Listar citas de un inquilino
app.get('/api/appointments', async (req, res): Promise<void> => {
  const { tenant_id } = req.query;
  if (!tenant_id) {
    res.status(400).json({ error: 'Se requiere el parámetro tenant_id.' });
    return;
  }
  
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('tenant_id', tenant_id)
      .order('date_time', { ascending: true });
    
    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Editar cita (PUT) - Sincronizado con Google Calendar
app.put('/api/appointments/:id', async (req, res): Promise<void> => {
  const { id } = req.params;
  const { patient_name, patient_phone, patient_email, date_time, specialty } = req.body;

  try {
    // Obtener la cita actual y los datos de su inquilino
    const { data: appointment, error: fetchErr } = await supabase
      .from('appointments')
      .select('*, tenants(*)')
      .eq('id', id)
      .single();

    if (fetchErr || !appointment) {
      res.status(404).json({ error: 'Cita no encontrada.' });
      return;
    }

    // Actualizar en base de datos Supabase
    const { data: updatedApp, error: updateErr } = await supabase
      .from('appointments')
      .update({
        patient_name,
        patient_phone,
        patient_email,
        date_time,
        specialty
      })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    // Sincronizar cambios en Google Calendar si tiene evento vinculado
    const tenant = appointment.tenants;
    if (appointment.google_event_id && tenant && tenant.google_refresh_token) {
      try {
        // Parsear fecha y hora
        const dt = new Date(date_time);
        const dateStr = dt.toISOString().split('T')[0];
        // Obtener HH:MM en zona horaria local de Madrid
        const timeStr = dt.toLocaleTimeString('es-ES', {
          timeZone: 'Europe/Madrid',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });

        console.log(`Sincronizando edición en Google Calendar (Evento: ${appointment.google_event_id}) el ${dateStr} a las ${timeStr}...`);
        await updateAppointment(
          tenant.google_refresh_token,
          appointment.google_event_id,
          dateStr,
          timeStr,
          patient_name,
          patient_email,
          patient_phone,
          specialty,
          appointment.google_calendar_id || 'primary',
          tenant.business_name,
          tenant.business_sector
        );
        console.log('✅ Google Calendar actualizado con éxito.');
      } catch (gErr: any) {
        console.error('⚠️ Error de sincronización con Google Calendar:', gErr.message);
      }
    }

    res.json(updatedApp);
  } catch (err: any) {
    console.error('Error al editar la cita:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5. Eliminar cita (DELETE) - Sincronizado con Google Calendar
app.delete('/api/appointments/:id', async (req, res): Promise<void> => {
  const { id } = req.params;

  try {
    // Obtener la cita actual y los datos de su inquilino
    const { data: appointment, error: fetchErr } = await supabase
      .from('appointments')
      .select('*, tenants(*)')
      .eq('id', id)
      .single();

    if (fetchErr || !appointment) {
      res.status(404).json({ error: 'Cita no encontrada.' });
      return;
    }

    // Eliminar de base de datos Supabase
    const { error: deleteErr } = await supabase
      .from('appointments')
      .delete()
      .eq('id', id);

    if (deleteErr) throw deleteErr;

    // Sincronizar eliminación en Google Calendar si tiene evento vinculado
    const tenant = appointment.tenants;
    if (appointment.google_event_id && tenant && tenant.google_refresh_token) {
      try {
        console.log(`Eliminando evento en Google Calendar (Evento: ${appointment.google_event_id})...`);
        await deleteAppointment(tenant.google_refresh_token, appointment.google_event_id, appointment.google_calendar_id || 'primary');
        console.log('✅ Evento de Google Calendar eliminado con éxito.');
      } catch (gErr: any) {
        console.error('⚠️ Error al eliminar evento de Google Calendar:', gErr.message);
      }
    }

    res.json({ status: 'success', message: 'Cita eliminada correctamente.' });
  } catch (err: any) {
    console.error('Error al eliminar la cita:', err);
    res.status(500).json({ error: err.message });
  }
});

// Ruta raíz que sirve el dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// Rutas limpias para Políticas de Google Cloud y RGPD
app.get('/politica-de-privacidad', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'politica-de-privacidad.html'));
});

app.get('/aviso-legal', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'aviso-legal.html'));
});

// Ruta limpia para Panel de Administrador
app.get('/admin', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
});

// Ruta para iniciar la autenticación de Google Calendar con tenant_id
app.get('/auth', async (req, res) => {
  try {
    const tenantId = req.query.tenant_id as string;
    if (!tenantId) {
      res.status(400).send('Error: Se requiere el parámetro tenant_id en la URL (ej: /auth?tenant_id=tu_uuid).');
      return;
    }
    
    // Pasar tenantId en el parámetro state para recuperarlo en el callback
    const url = await getAuthUrl(tenantId);
    res.redirect(url);
  } catch (error: any) {
    console.error('Error al generar la URL de autenticación:', error);
    res.status(500).send(`Error al iniciar la autenticación: ${error.message}`);
  }
});

// Ruta Callback para la API de Google
app.get('/oauth2callback', async (req, res): Promise<void> => {
  const code = req.query.code as string;
  const tenantId = req.query.state as string;

  if (!code) {
    res.status(400).send('Falta el código de autorización.');
    return;
  }

  if (!tenantId) {
    res.status(400).send('Falta el parámetro state (tenant_id) de asociación.');
    return;
  }

  try {
    console.log(`Exchanging OAuth2 code for tokens. Tenant: ${tenantId}`);
    const tokens = await getTokensFromCode(code);
    
    if (!tokens.refresh_token) {
      console.warn('⚠️ No se recibió refresh_token. Es posible que el usuario ya esté autenticado. Si necesitas de nuevo el token, revoca la app en tu cuenta de Google.');
    }

    // Actualizar el google_refresh_token del inquilino en Supabase
    const updateData: any = {};
    if (tokens.refresh_token) {
      updateData.google_refresh_token = tokens.refresh_token;
    } else {
      res.status(400).send('Error: Google no devolvió un refresh_token. Ve a la configuración de seguridad de tu cuenta de Google, elimina el acceso de la aplicación "Receptia" e inténtalo de nuevo para forzar a Google a enviar el refresh_token.');
      return;
    }
    
    console.log(`Guardando tokens en Supabase para el tenant: ${tenantId}...`);
    const { error: dbError } = await supabase
      .from('tenants')
      .update(updateData)
      .eq('id', tenantId);

    if (dbError) {
      throw new Error(`Error en base de datos al guardar tokens: ${dbError.message}`);
    }

    console.log('✅ Token OAuth guardado exitosamente en base de datos.');

    res.send(`
      <html>
        <head>
          <title>Autenticación Exitosa</title>
          <style>
            body { font-family: sans-serif; background: #0b0f19; color: #e0e0e0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #111827; border: 1px solid rgba(139, 92, 246, 0.2); padding: 3rem; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; max-width: 450px; }
            .btn { display: inline-block; margin-top: 1.5rem; background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); color: white; padding: 0.75rem 1.5rem; border-radius: 8px; text-decoration: none; font-weight: 600; transition: transform 0.2s; }
            .btn:hover { transform: scale(1.05); }
          </style>
          <script>
            setTimeout(function() {
              window.location.href = "/?tenant_id=${tenantId}";
            }, 3000);
          </script>
        </head>
        <body>
          <div class="card">
            <h1 style="color: #10b981; font-size: 1.8rem; margin-bottom: 1rem;">¡Conexión Completada! 🎉</h1>
            <p style="color: #9ca3af; line-height: 1.6; margin-bottom: 1.5rem;">Tu cuenta de Google Calendar se ha conectado correctamente a Receptia.</p>
            <p style="color: #6b7280; font-size: 0.85rem;">Serás redirigido a tu panel en 3 segundos...</p>
            <a href="/?tenant_id=${tenantId}" class="btn">Volver al Panel</a>
          </div>
        </body>
      </html>
    `);
  } catch (error: any) {
    console.error('Error en oauth2callback:', error);
    res.status(500).send(`Error al guardar el token en la base de datos: ${error.message}`);
  }
});

// =====================================================================
// GESTIÓN DEL CICLO DE VIDA DE CLIENTES: Suspender, Archivar, Restaurar
// =====================================================================

// 6A. Listar clientes archivados (historial)
app.get('/api/admin/tenants/archived', async (req, res): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('tenants')
      .select('*')
      .eq('is_archived', true)
      .order('archived_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6B. Suspender el servicio de un cliente
app.patch('/api/admin/tenants/:id/suspend', async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    // Buscar el tenant para obtener su agente de Retell
    const { data: tenant, error: fetchErr } = await supabase
      .from('tenants')
      .select('retell_agent_id')
      .eq('id', id)
      .single();
    if (fetchErr || !tenant) {
      res.status(404).json({ error: 'Cliente no encontrado.' });
      return;
    }
    // Actualizar estado en Supabase
    const { data, error } = await supabase
      .from('tenants')
      .update({ subscription_status: 'paused' })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    console.log(`[Suspensión] Cliente ${id} suspendido.`);
    res.json({ success: true, tenant: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6C. Reactivar el servicio de un cliente suspendido
app.patch('/api/admin/tenants/:id/reactivate', async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('tenants')
      .update({ subscription_status: 'active' })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, tenant: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6D. Archivar un cliente (soft delete con motivo)
app.patch('/api/admin/tenants/:id/archive', async (req, res): Promise<void> => {
  const { id } = req.params;
  const { reason } = req.body; // 'non_payment', 'voluntary_cancel', 'fraud', 'other'
  try {
    const { data, error } = await supabase
      .from('tenants')
      .update({
        is_archived: true,
        archived_at: new Date().toISOString(),
        archived_reason: reason || 'other',
        subscription_status: 'cancelled'
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    console.log(`[Archivado] Cliente ${id} archivado. Motivo: ${reason}`);
    res.json({ success: true, tenant: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6E. Recuperar un cliente del histórico de archivados
app.patch('/api/admin/tenants/:id/restore', async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('tenants')
      .update({
        is_archived: false,
        archived_at: null,
        archived_reason: null,
        subscription_status: 'trial' // Empieza en trial hasta que el admin asigne nuevo plan
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    console.log(`[Restauración] Cliente ${id} recuperado del histórico.`);
    res.json({ success: true, tenant: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6F. Eliminar un cliente de forma definitiva (hard delete)
app.delete('/api/admin/tenants/:id', async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    // 1. Obtener los datos del inquilino antes de eliminar para sacar su retell_agent_id
    const { data: tenant, error: getError } = await supabase
      .from('tenants')
      .select('retell_agent_id, business_name')
      .eq('id', id)
      .maybeSingle();

    if (getError) throw getError;
    if (!tenant) {
      res.status(404).json({ error: 'Inquilino no encontrado.' });
      return;
    }

    // 2. Eliminar el agente en Retell AI si existe
    if (tenant.retell_agent_id) {
      await deleteRetellAgent(tenant.retell_agent_id);
    }

    // 3. Eliminar el registro de Supabase (el cascade borrará citas, call logs, etc.)
    const { error: deleteError } = await supabase
      .from('tenants')
      .delete()
      .eq('id', id);

    if (deleteError) throw deleteError;

    console.log(`[Eliminación Definitiva] Cliente ${tenant.business_name} (${id}) eliminado del sistema.`);
    res.json({ success: true, message: `Cliente ${tenant.business_name} eliminado definitivamente.` });
  } catch (err: any) {
    console.error('Error al eliminar inquilino:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// 6. Super-Admin: Crear y aprovisionar un Agente de Voz IA dinámicamente con barra de progreso
// =====================================================================
app.post('/api/admin/tenants', async (req, res): Promise<void> => {
  const { 
    business_name, 
    email, 
    specialties,
    voice_id,
    phone_provider,
    phone_number,
    sip_username,
    sip_password,
    sip_server,
    working_hours,
    business_description,
    pricing_details,
    custom_instructions,
    subscription_status,
    subscription_plan,
    billing_cycle,
    price_amount,
    contract_start_date,
    contract_end_date,
    admin_pin,
    contract_template_id,
    signed_contract_content,
    is_trial,
    whatsapp_reminders_enabled,
    enable_multi_professional,
    professionals,
    knowledge_base_url,
    knowledge_base_content,
    is_signed_by_admin,
    admin_signature_name,
    is_signed_by_client,
    client_signature_name,
    contract_email_sent,
    legal_address,
    tax_id,
    representative_name,
    representative_id,
    representative_role,
    signing_city,
    retell_agent_id,
    business_sector,
    voice_speed,
    voice_temperature,
    vacation_mode,
    vacation_message,
    voice_responsiveness,
    whatsapp_reminder_hours,
    email_notifications_enabled,
    client_whatsapp_provider,
    twilio_account_sid,
    twilio_auth_token,
    twilio_whatsapp_number,
    whatsapp_immediate_notification_enabled
  } = req.body;

  if (!business_name || !email) {
    res.status(400).json({ error: 'El nombre del negocio y el email son obligatorios.' });
    return;
  }

  const steps: string[] = [];
  const addStep = (msg: string) => {
    console.log(`[Aprovisionamiento] ${msg}`);
    steps.push(msg);
  };

  const formattedVoiceIdVal = formatVoiceId(voice_id);

  try {
    // Paso 1: Registrar o actualizar en Supabase
    addStep('1. Creando o actualizando registro del negocio en Supabase...');
    const { data: existing } = await supabase
      .from('tenants')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    let computedAgentId = retell_agent_id;
    if (computedAgentId === '') {
      computedAgentId = null;
    } else if (!computedAgentId && existing && existing.retell_agent_id) {
      computedAgentId = existing.retell_agent_id;
    }

    let computedStatus = subscription_status || 'active';
    let computedTrialEndsAt = null;
    if (is_trial) {
      computedStatus = 'trial';
      const startDate = contract_start_date ? new Date(contract_start_date) : new Date();
      startDate.setDate(startDate.getDate() + 7);
      computedTrialEndsAt = startDate.toISOString().split('T')[0];
    }

    let computedSignedByAdminAt = null;
    if (is_signed_by_admin) {
      computedSignedByAdminAt = existing && existing.signed_by_admin_at ? existing.signed_by_admin_at : new Date().toISOString();
    }
    
    let computedSignedByClientAt = null;
    if (is_signed_by_client) {
      computedSignedByClientAt = existing && existing.signed_by_client_at ? existing.signed_by_client_at : new Date().toISOString();
    }

    let computedEmailSentAt = null;
    if (contract_email_sent) {
      computedEmailSentAt = existing && existing.contract_email_sent_at ? existing.contract_email_sent_at : new Date().toISOString();
    }

    let workingHoursObj = working_hours;
    if (existing && existing.working_hours) {
      const prevWorkingHours = typeof existing.working_hours === 'string' ? JSON.parse(existing.working_hours) : existing.working_hours;
      if (prevWorkingHours && prevWorkingHours.client_enable_multi_professional !== undefined) {
        if (!workingHoursObj) {
          workingHoursObj = { client_enable_multi_professional: prevWorkingHours.client_enable_multi_professional };
        } else {
          if (typeof workingHoursObj === 'string') {
            try { workingHoursObj = JSON.parse(workingHoursObj); } catch (e) {}
          }
          workingHoursObj.client_enable_multi_professional = prevWorkingHours.client_enable_multi_professional;
        }
      }
    }

    let tenant: any;
    const tenantData: any = {
      business_name,
      specialties,
      voice_id: formattedVoiceIdVal,
      phone_provider,
      phone_number: phone_number !== undefined ? phone_number : (existing ? existing.phone_number : null),
      sip_username,
      sip_password,
      sip_server,
      working_hours: workingHoursObj,
      business_description,
      pricing_details,
      custom_instructions,
      subscription_status: computedStatus,
      subscription_plan: subscription_plan || 'Plan Estándar Mensual',
      billing_cycle: billing_cycle || 'monthly',
      price_amount: price_amount !== undefined ? price_amount : 149.00,
      contract_start_date: contract_start_date || new Date().toISOString().split('T')[0],
      contract_end_date: contract_end_date || null,
      admin_pin: admin_pin || null,
      contract_template_id: contract_template_id || null,
      signed_contract_content: signed_contract_content || null,
      is_trial: !!is_trial,
      trial_ends_at: computedTrialEndsAt,
      whatsapp_reminders_enabled: !!whatsapp_reminders_enabled,
      email_notifications_enabled: email_notifications_enabled !== false,
      enable_no_show_deposits: false,
      no_show_deposit_amount: 10.00,
      enable_multi_professional: !!enable_multi_professional,
      professionals: professionals || [],
      knowledge_base_url: knowledge_base_url || null,
      knowledge_base_content: knowledge_base_content || null,
      is_signed_by_admin: !!is_signed_by_admin,
      admin_signature_name: admin_signature_name || null,
      signed_by_admin_at: computedSignedByAdminAt,
      is_signed_by_client: !!is_signed_by_client,
      client_signature_name: client_signature_name || null,
      signed_by_client_at: computedSignedByClientAt,
      contract_email_sent: !!contract_email_sent,
      contract_email_sent_at: computedEmailSentAt,
      legal_address: legal_address || null,
      tax_id: tax_id || null,
      representative_name: representative_name || null,
      representative_id: representative_id || null,
      representative_role: representative_role || null,
      signing_city: signing_city || null,
      retell_agent_id: computedAgentId,
      business_sector: business_sector || 'general',
      voice_speed: voice_speed !== undefined && voice_speed !== null ? Number(voice_speed) : 1.0,
      voice_temperature: voice_temperature !== undefined && voice_temperature !== null ? Number(voice_temperature) : 1.0,
      voice_responsiveness: voice_responsiveness !== undefined && voice_responsiveness !== null ? Number(voice_responsiveness) : 1.0,
      vacation_mode: vacation_mode !== undefined ? !!vacation_mode : (existing ? existing.vacation_mode : false),
      vacation_message: vacation_message !== undefined ? vacation_message : (existing ? existing.vacation_message : ''),
      whatsapp_reminder_hours: whatsapp_reminder_hours !== undefined ? Number(whatsapp_reminder_hours) : (existing ? existing.whatsapp_reminder_hours : 24),
      no_show_deposit_limit_mins: 10,
      client_whatsapp_provider: client_whatsapp_provider !== undefined ? client_whatsapp_provider : (existing ? existing.client_whatsapp_provider : 'qr'),
      twilio_account_sid: twilio_account_sid !== undefined ? twilio_account_sid : (existing ? existing.twilio_account_sid : null),
      twilio_auth_token: twilio_auth_token !== undefined ? twilio_auth_token : (existing ? existing.twilio_auth_token : null),
      twilio_whatsapp_number: twilio_whatsapp_number !== undefined ? twilio_whatsapp_number : (existing ? existing.twilio_whatsapp_number : null),
      whatsapp_immediate_notification_enabled: whatsapp_immediate_notification_enabled !== undefined ? !!whatsapp_immediate_notification_enabled : (existing ? existing.whatsapp_immediate_notification_enabled : true)
    };

    if (existing) {
      let attemptData: any = { ...tenantData };
      let retries = 10;
      let success = false;
      let lastError: any = null;

      while (retries > 0 && !success) {
        const result = await supabase
          .from('tenants')
          .update(attemptData)
          .eq('id', existing.id)
          .select()
          .single();
        
        if (result.error) {
          lastError = result.error;
          const errMsg = result.error.message || '';
          if (errMsg.includes('column') && retries > 1) {
            const match = errMsg.match(/['"]([^'"]+)['"]/);
            if (match && match[1]) {
              const colName = match[1];
              console.warn(`[Supabase Fallback] Columna faltante detectada en admin/tenants (update): ${colName}. Eliminando y reintentando...`);
              delete attemptData[colName];
              retries--;
              continue;
            }
          }
          throw result.error;
        }
        
        tenant = result.data;
        success = true;
      }
      if (!success && lastError) throw lastError;
    } else {
      let attemptData: any = { ...tenantData };
      let retries = 10;
      let success = false;
      let lastError: any = null;

      while (retries > 0 && !success) {
        const result = await supabase
          .from('tenants')
          .insert({ ...attemptData, email })
          .select()
          .single();
        
        if (result.error) {
          lastError = result.error;
          const errMsg = result.error.message || '';
          if (errMsg.includes('column') && retries > 1) {
            const match = errMsg.match(/['"]([^'"]+)['"]/);
            if (match && match[1]) {
              const colName = match[1];
              console.warn(`[Supabase Fallback] Columna faltante detectada en admin/tenants (insert): ${colName}. Eliminando y reintentando...`);
              delete attemptData[colName];
              retries--;
              continue;
            }
          }
          throw result.error;
        }
        
        tenant = result.data;
        success = true;
      }
      if (!success && lastError) throw lastError;
    }

    addStep('2. Registro en Supabase completado con UUID: ' + tenant.id);

    // Paso 2: Conectar con Retell AI
    let webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
    if (!webhookBaseUrl) {
      const host = req.get('host') || '';
      const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
      webhookBaseUrl = `${protocol}://${host}`;
    }

    if (computedAgentId) {
      addStep('3. Sincronizando agente de voz existente en Retell AI...');
      try {
        await syncTenantWithRetell(tenant, webhookBaseUrl);
        addStep('4. Sincronización del agente existente completada con éxito.');
      } catch (syncErr: any) {
        addStep(`⚠️ Aviso: No se pudo sincronizar el agente en Retell AI (${syncErr.message}).`);
      }
    } else {
      const RETELL_API_KEY = process.env.RETELL_API_KEY;
      if (RETELL_API_KEY && RETELL_API_KEY !== 'YOUR_RETELL_API_KEY') {
        const retellClient = axios.create({
          baseURL: 'https://api.retellai.com',
          headers: {
            Authorization: `Bearer ${RETELL_API_KEY}`,
            'Content-Type': 'application/json',
          },
        });

        // 2A: Crear LLM con herramientas integradas
        addStep('3. Creando LLM personalizado en Retell AI...');
        const systemPrompt = compileSystemPrompt(tenant);
        
        const generalTools = [
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
                  description: 'La fecha para consultar en formato YYYY-MM-DD (ej. 2026-06-20).',
                },
              },
              required: ['date'],
            },
          },
          {
            type: 'custom',
            name: 'crear_cita',
            description: 'Reserva una cita en el calendario tras confirmar los datos con el paciente.',
            url: `${webhookBaseUrl}/api/webhook/book-appointment?tenant_id=${tenant.id}`,
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
                  description: 'Servicio o especialidad solicitada.',
                },
              },
              required: ['date', 'time', 'name', 'email', 'phone', 'specialty'],
            },
          },
        ];

        const llmRes = await retellClient.post('/create-retell-llm', {
          general_prompt: systemPrompt,
          model: 'gpt-4o',
          general_tools: generalTools,
        });
        const llmId = llmRes.data.llm_id;
        addStep('4. LLM creado con ID: ' + llmId);

        // 2B: Crear Agente
        addStep('5. Registrando Agente de Voz en Retell AI...');
        let agentRes;
        const requestedVoiceId = formattedVoiceIdVal || 'cartesia-Sofia';
        const agentName = resolveAgentName(requestedVoiceId);
        try {
          agentRes = await retellClient.post('/create-agent', {
            agent_name: `${agentName} - ${business_name}`,
            response_engine: {
              type: 'retell-llm',
              llm_id: llmId,
            },
            voice_id: requestedVoiceId,
            language: 'es-ES',
            webhook_url: `${webhookBaseUrl}/api/webhook/agent-events`,
            reminder_max_count: 0,
          });
        } catch (agentErr: any) {
          if (agentErr.response && agentErr.response.status === 404 && requestedVoiceId !== 'cartesia-Sofia') {
            addStep(`⚠️ Aviso: La voz "${requestedVoiceId}" no existe en Retell AI. Asignando voz por defecto (cartesia-Sofia)...`);
            agentRes = await retellClient.post('/create-agent', {
              agent_name: `Sofía - ${business_name}`,
              response_engine: {
                type: 'retell-llm',
                llm_id: llmId,
              },
              voice_id: 'cartesia-Sofia',
              language: 'es-ES',
              webhook_url: `${webhookBaseUrl}/api/webhook/agent-events`,
              reminder_max_count: 0,
            });
          } else {
            throw agentErr;
          }
        }
        const agentId = agentRes.data.agent_id;
        addStep('6. Agente creado con ID: ' + agentId);

        // 2C: Configurar Teléfono
        let finalPhoneNumber = tenant.phone_number;
        if (phone_provider === 'retell') {
          addStep('7. Intentando adquirir número telefónico en Retell AI...');
          try {
            const phoneRes = await retellClient.post('/buy-phone-number', {
              area_code: 415,
              nickname: business_name,
            });
            const phoneId = phoneRes.data.phone_number_id;
            finalPhoneNumber = phoneRes.data.phone_number;
            
            addStep('8. Número comprado: ' + finalPhoneNumber + '. Vinculándolo al agente...');
            await retellClient.patch(`/update-phone-number/${phoneId}`, {
              inbound_agent_id: agentId,
            });
            addStep('9. Número vinculado con éxito.');
          } catch (phoneErr: any) {
            addStep('⚠️ Aviso: No se pudo comprar el número en Retell automáticamente (fondos insuficientes o restricciones de área). Deberás vincularlo manualmente.');
            console.warn('Error al comprar número Retell:', phoneErr.message);
          }
        } else if (phone_provider === 'zadarma' && sip_username && sip_server) {
          addStep('7. Registrando conexión SIP (Zadarma) en Retell AI...');
          try {
            const connRes = await retellClient.post('/create-connection', {
              connection_name: `Zadarma - ${business_name}`,
              sip_trunk: {
                username: sip_username,
                password: sip_password,
                server: sip_server,
              }
            });
            const connectionId = connRes.data.connection_id;
            addStep('8. Conexión SIP creada. Vinculándola al agente...');
            await retellClient.patch(`/update-connection/${connectionId}`, {
              inbound_agent_id: agentId,
            });
            addStep('9. Conexión SIP vinculada con éxito.');
            finalPhoneNumber = `SIP: ${sip_username}`;
          } catch (sipErr: any) {
            addStep('⚠️ Aviso: No se pudo registrar la conexión SIP automáticamente. Configúrala manualmente en tu panel de Retell.');
            console.warn('Error al registrar SIP en Retell:', sipErr.response?.data || sipErr.message);
          }

          // Importar o actualizar el número telefónico (DID) en Retell de forma independiente (no depende del SIP trunk)
          if (phone_number) {
            addStep(`10. Configurando número telefónico custom ${phone_number} en Retell AI...`);
            try {
              await retellClient.post('/import-phone-number', {
                phone_number: phone_number,
                termination_uri: sip_server,
                nickname: `Zadarma - ${business_name}`,
                inbound_agent_id: agentId
              });
              addStep('11. Número custom importado y vinculado al agente.');
              finalPhoneNumber = phone_number;
            } catch (importErr: any) {
              console.warn('Aviso: No se pudo importar el número custom en Retell (puede que ya exista):', importErr.response?.data || importErr.message);
              // Si ya existe, intentar actualizarlo
              try {
                await retellClient.patch(`/update-phone-number/${phone_number}`, {
                  inbound_agent_id: agentId
                });
                addStep('11. Número custom actualizado y vinculado al agente.');
                finalPhoneNumber = phone_number;
              } catch (updPhoneErr: any) {
                console.warn('Error al actualizar número custom:', updPhoneErr.response?.data || updPhoneErr.message);
              }
            }
          }
        }

        // Guardar el Retell Agent ID y teléfono en Supabase
        addStep('10. Actualizando ID del agente y teléfono en la base de datos...');
        const { data: finalTenant, error: dbErr } = await supabase
          .from('tenants')
          .update({
            retell_agent_id: agentId,
            phone_number: finalPhoneNumber
          })
          .eq('id', tenant.id)
          .select()
          .single();
        
        if (dbErr) throw dbErr;
        tenant = finalTenant;
      } else {
        addStep('⚠️ Aviso: RETELL_API_KEY no configurada. Saltando aprovisionamiento en Retell AI.');
      }
    }

    addStep('11. ¡Agente de IA generado con éxito!');
    res.json({
      status: 'success',
      tenant,
      steps
    });
  } catch (err: any) {
    console.error('Error en pipeline de aprovisionamiento:', err.response?.data || err);
    res.status(500).json({ 
      error: 'Error en la generación del agente', 
      details: err.response?.data?.message || err.message,
      steps 
    });
  }
});

// 7. Backup: Exportar todos los datos (tenants y appointments)
app.get('/api/admin/backup', async (req, res): Promise<void> => {
  try {
    const { data: tenants, error: tErr } = await supabase.from('tenants').select('*');
    if (tErr) throw tErr;

    const { data: appointments, error: aErr } = await supabase.from('appointments').select('*');
    if (aErr) throw aErr;

    res.json({ tenants, appointments });
  } catch (err: any) {
    console.error('Error al generar copia de seguridad:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8. Restore: Importar datos (tenants y appointments)
app.post('/api/admin/restore', async (req, res): Promise<void> => {
  const { tenants, appointments } = req.body;
  if (!tenants || !appointments) {
    res.status(400).json({ error: 'Faltan datos de tenants o appointments para restaurar.' });
    return;
  }

  try {
    // Restaurar tenants (upsert por ID)
    if (tenants.length > 0) {
      const { error: tErr } = await supabase.from('tenants').upsert(tenants);
      if (tErr) throw tErr;
    }

    // Restaurar appointments (upsert por ID)
    if (appointments.length > 0) {
      const { error: aErr } = await supabase.from('appointments').upsert(appointments);
      if (aErr) throw aErr;
    }

    res.json({ status: 'success', message: 'Copia de seguridad restaurada correctamente.' });
  } catch (err: any) {
    console.error('Error al restaurar copia de seguridad:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// INTEGRACIÓN CON STRIPE BILLING (MONETIZACIÓN SAAS)
// ========================================================

// 1. Crear sesión de Stripe Checkout
app.post('/api/payments/create-checkout-session', async (req, res): Promise<void> => {
  const { tenant_id, plan_id } = req.body;
  if (!tenant_id || !plan_id) {
    res.status(400).json({ error: 'Faltan parámetros obligatorios (tenant_id, plan_id).' });
    return;
  }

  try {
    const host = req.get('host') || '';
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
    const origin = `${protocol}://${host}`;
    
    const checkoutUrl = await createStripeCheckoutSession(tenant_id, plan_id, origin);
    res.json({ url: checkoutUrl });
  } catch (err: any) {
    console.error('Error al crear checkout session de Stripe:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. Crear sesión del portal de Stripe para autogestión de clientes
app.post('/api/payments/create-portal-session', async (req, res): Promise<void> => {
  const { tenant_id } = req.body;
  if (!tenant_id) {
    res.status(400).json({ error: 'Falta el parámetro obligatorio tenant_id.' });
    return;
  }

  try {
    const host = req.get('host') || '';
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
    const origin = `${protocol}://${host}`;

    const portalUrl = await createStripePortalSession(tenant_id, origin);
    res.json({ url: portalUrl });
  } catch (err: any) {
    console.error('Error al crear portal session de Stripe:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. Webhook de Stripe para notificaciones asíncronas en la nube
app.post('/api/payments/webhook', async (req, res): Promise<void> => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = await getSettingVal('STRIPE_WEBHOOK_SECRET') || process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig) {
    res.status(400).send('Falta la cabecera stripe-signature.');
    return;
  }

  try {
    const stripe = await getStripeClient();
    let event;
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent((req as any).rawBody, sig, webhookSecret);
    } else {
      console.warn('⚠️ STRIPE_WEBHOOK_SECRET no está configurado. Procesando webhook sin verificar firma (¡solo usar en desarrollo!).');
      event = req.body;
    }

    console.log(`🔔 Stripe Webhook recibido: ${event.type}`);

    // Resolver webhook base URL para sincronizar con Retell
    const host = req.get('host') || '';
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
    const webhookBaseUrl = `${protocol}://${host}`;

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const tenantId = session.metadata?.tenant_id;
        const planId = session.metadata?.plan_id;

        if (tenantId && planId) {
          // Obtener detalles del plan
          const { data: plan, error: pErr } = await supabase
            .from('plans')
            .select('*')
            .eq('id', planId)
            .maybeSingle();

          const planName = plan?.name || (planId === 'premium' ? 'Plan Premium Mensual' : 'Plan Estándar Mensual');
          const planCycle = plan?.cycle || 'monthly';
          const planPrice = plan?.price || (planId === 'premium' ? 249.00 : 149.00);

          const todayStr = new Date().toISOString().split('T')[0];

          // Actualizar tenant en Supabase
          const { error: updErr } = await supabase
            .from('tenants')
            .update({
              subscription_status: 'active',
              subscription_plan: planName,
              billing_cycle: planCycle,
              price_amount: planPrice,
              stripe_subscription_id: session.subscription,
              is_trial: false,
              trial_ends_at: null,
              contract_start_date: todayStr
            })
            .eq('id', tenantId);

          if (updErr) {
            console.error(`❌ Error al actualizar suscripción de tenant ${tenantId} tras webhook checkout.completed:`, updErr.message);
          } else {
            console.log(`✅ Suscripción de tenant ${tenantId} activada con éxito en la base de datos.`);
            
            // Cargar de nuevo el tenant con su nuevo estado y sincronizar con Retell AI
            const { data: updatedTenant } = await supabase
              .from('tenants')
              .select('*')
              .eq('id', tenantId)
              .single();
            
            if (updatedTenant && updatedTenant.retell_agent_id) {
              await syncTenantWithRetell(updatedTenant, webhookBaseUrl);
            }
          }
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const { data: tenant } = await supabase
            .from('tenants')
            .select('*')
            .eq('stripe_customer_id', invoice.customer)
            .maybeSingle();

          if (tenant) {
            const concept = `Pago Suscripción Stripe: ${tenant.business_name} - Factura ${invoice.number || ''}`;
            const amount = (invoice.amount_paid || 0) / 100;
            const todayStr = new Date().toISOString().split('T')[0];

            // Registrar transacción contable
            const { error: txErr } = await supabase
              .from('accounting_transactions')
              .insert({
                type: 'income',
                concept,
                amount,
                date: todayStr
              });

            if (txErr) {
              console.warn('⚠️ No se pudo registrar la transacción contable tras factura exitosa:', txErr.message);
            } else {
              console.log(`✅ Pago de factura por $${amount} registrado en contabilidad para ${tenant.business_name}.`);
            }
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const { data: tenant } = await supabase
          .from('tenants')
          .select('*')
          .eq('stripe_subscription_id', subscription.id)
          .maybeSingle();

        if (tenant) {
          console.log(`⚠️ Suscripción cancelada en Stripe para ${tenant.business_name}. Pausando servicio...`);
          
          // Actualizar base de datos
          const { error: updErr } = await supabase
            .from('tenants')
            .update({
              subscription_status: 'inactive',
              stripe_subscription_id: null
            })
            .eq('id', tenant.id);

          if (updErr) {
            console.error(`❌ Error al desactivar suscripción del tenant ${tenant.id} en base de datos:`, updErr.message);
          } else {
            console.log(`✅ Suscripción de tenant ${tenant.id} cambiada a inactiva.`);
            
            // Cargar de nuevo el tenant con su nuevo estado inactivo y sincronizar con Retell AI (para aplicar prompt de suspensión)
            const { data: updatedTenant } = await supabase
              .from('tenants')
              .select('*')
              .eq('id', tenant.id)
              .single();
            
            if (updatedTenant && updatedTenant.retell_agent_id) {
              await syncTenantWithRetell(updatedTenant, webhookBaseUrl);
            }
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const { data: tenant } = await supabase
            .from('tenants')
            .select('*')
            .eq('stripe_customer_id', invoice.customer)
            .maybeSingle();

          if (tenant) {
            console.log(`❌ Pago fallido en Stripe para ${tenant.business_name}. Marcando como suspendido...`);
            
            const { error: updErr } = await supabase
              .from('tenants')
              .update({
                subscription_status: 'suspended'
              })
              .eq('id', tenant.id);

            if (updErr) {
              console.error(`❌ Error al suspender tenant ${tenant.id} tras impago:`, updErr.message);
            } else {
              console.log(`✅ Suscripción de tenant ${tenant.id} cambiada a suspendida.`);
              
              // Cargar de nuevo el tenant con su nuevo estado suspendido y sincronizar con Retell AI (para aplicar prompt de suspensión)
              const { data: updatedTenant } = await supabase
                .from('tenants')
                .select('*')
                .eq('id', tenant.id)
                .single();
              
              if (updatedTenant && updatedTenant.retell_agent_id) {
                await syncTenantWithRetell(updatedTenant, webhookBaseUrl);
              }
            }
          }
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error('Error procesando webhook de Stripe:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// 0. Pasarela de Pago Simulada
app.post('/api/payments/checkout-success', async (req, res): Promise<void> => {
  const { tenant_id, plan_id, gateway } = req.body;
  if (!tenant_id || !plan_id) {
    res.status(400).json({ error: 'Faltan parámetros obligatorios (tenant_id, plan_id).' });
    return;
  }

  try {
    // 1. Obtener detalles del plan
    let plan: any;
    const { data: dbPlan, error: pErr } = await supabase.from('plans').select('*').eq('id', plan_id).maybeSingle();
    
    if (pErr || !dbPlan) {
      const fallbackPlans: Record<string, any> = {
        estandar: { name: 'Plan Estándar Mensual', price: 149.00, cycle: 'monthly' },
        premium: { name: 'Plan Premium Mensual', price: 249.00, cycle: 'monthly' },
        anual: { name: 'Plan Premium Anual', price: 2290.00, cycle: 'annually' },
        estandar_mensual: { name: 'Plan Estándar Mensual', price: 149.00, cycle: 'monthly' },
        premium_mensual: { name: 'Plan Premium Mensual', price: 249.00, cycle: 'monthly' },
        estandar_anual: { name: 'Plan Estándar Anual', price: 1290.00, cycle: 'annually' },
        premium_anual: { name: 'Plan Premium Anual', price: 2290.00, cycle: 'annually' }
      };
      plan = fallbackPlans[plan_id];
      if (!plan) throw new Error('Plan de precios no válido.');
    } else {
      plan = dbPlan;
    }

    // 2. Obtener cliente (tenant)
    const { data: tenant, error: tErr } = await supabase.from('tenants').select('*').eq('id', tenant_id).single();
    if (tErr || !tenant) {
      res.status(404).json({ error: 'Cliente no encontrado.' });
      return;
    }

    const todayStr = new Date().toISOString().split('T')[0];

    // 3. Actualizar cliente en Supabase
    const { error: updErr } = await supabase
      .from('tenants')
      .update({
        subscription_status: 'active',
        subscription_plan: plan.name,
        billing_cycle: plan.cycle,
        price_amount: plan.price,
        is_trial: false,
        trial_ends_at: null,
        contract_start_date: todayStr
      })
      .eq('id', tenant_id);

    if (updErr) throw updErr;

    // 4. Registrar cobro en Contabilidad
    const gatewayLabel = gateway === 'paypal' ? 'PayPal' : 'Stripe';
    const concept = `Pago Suscripción ${gatewayLabel}: ${tenant.business_name} - ${plan.name}`;
    
    const { error: txErr } = await supabase
      .from('accounting_transactions')
      .insert({
        type: 'income',
        concept,
        amount: plan.price,
        date: todayStr
      });

    if (txErr) {
      console.warn('⚠️ No se pudo registrar la transacción contable (puede que la tabla no exista aún):', txErr.message);
    }

    res.json({ 
      status: 'success', 
      message: 'Suscripción pagada y activada correctamente.',
      plan: plan.name
    });
  } catch (err: any) {
    console.error('Error en checkout-success:', err);
    res.status(500).json({ error: err.message });
  }
});

// 1. Gestión de Planes de Precios
app.get('/api/admin/plans', async (req, res): Promise<void> => {
  try {
    const { data: plans, error } = await supabase.from('plans').select('*').order('price', { ascending: true });
    if (error) {
      if (error.code === '42P01') {
        const defaultPlans = [
          {
            id: 'estandar_mensual',
            name: 'Plan Estándar Mensual',
            price: 149.00,
            cycle: 'monthly',
            features: ['1 Agente de Voz IA activo', '1 Número telefónico en Retell AI', 'Integración con Google Calendar', 'Panel de control de cliente', 'Hasta 200 minutos incluidos / mes', 'Minuto adicional a 0.20€/min'],
            description: 'Plan estándar para medianos y pequeños comercios.'
          },
          {
            id: 'premium_mensual',
            name: 'Plan Premium Mensual',
            price: 249.00,
            cycle: 'monthly',
            features: ['Todo lo del Plan Estándar', 'Conexión SIP Zadarma avanzada', 'Soporte de Voz ElevenLabs de alta calidad', 'Prompt e instrucciones optimizadas', 'Hasta 500 minutos incluidos / mes', 'Minuto adicional a 0.20€/min'],
            description: 'Más Popular'
          },
          {
            id: 'estandar_anual',
            name: 'Plan Estándar Anual',
            price: 1290.00,
            cycle: 'annually',
            features: ['1 Agente de Voz IA activo', '1 Número telefónico en Retell AI', 'Integración con Google Calendar', 'Panel de control de cliente', 'Hasta 200 minutos incluidos / mes', 'Minuto adicional a 0.20€/min', 'Ahorro de casi 3 meses de suscripción'],
            description: 'Ahorro de casi 3 meses de suscripción'
          },
          {
            id: 'premium_anual',
            name: 'Plan Premium Anual',
            price: 2290.00,
            cycle: 'annually',
            features: ['Todo lo del Plan Premium', 'Soporte VIP priorizado 24/7', 'Ahorro de 2 meses de suscripción', 'Minutos ilimitados controlados'],
            description: 'Ahorro de 2 meses de suscripción'
          }
        ];
        res.json({ plans: defaultPlans, migration_required: true });
        return;
      }
      throw error;
    }
    res.json({ plans, migration_required: false });
  } catch (err: any) {
    console.error('Error al listar planes:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/plans/:id', async (req, res): Promise<void> => {
  const { id } = req.params;
  const { name, price, cycle, features, description } = req.body;
  try {
    const { data, error } = await supabase
      .from('plans')
      .update({ name, price: Number(price), cycle, features, description })
      .eq('id', id)
      .select()
      .single();
    
    if (error) {
      if (error.code === '42P01') {
        res.status(400).json({ error: 'La tabla "plans" no existe. Por favor, ejecuta la migración SQL en Supabase.' });
        return;
      }
      throw error;
    }
    res.json({ status: 'success', plan: data });
  } catch (err: any) {
    console.error('Error al actualizar plan:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Gestión de Transacciones Manuales (Contabilidad)
app.get('/api/admin/transactions', async (req, res): Promise<void> => {
  try {
    const { data: transactions, error } = await supabase
      .from('accounting_transactions')
      .select('*')
      .order('date', { ascending: false });
    
    if (error) {
      if (error.code === '42P01') {
        res.json({ transactions: [], migration_required: true });
        return;
      }
      throw error;
    }
    res.json({ transactions, migration_required: false });
  } catch (err: any) {
    console.error('Error al listar transacciones:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/transactions', async (req, res): Promise<void> => {
  const { type, concept, amount, date } = req.body;
  if (!type || !concept || amount === undefined) {
    res.status(400).json({ error: 'Tipo, concepto e importe son obligatorios.' });
    return;
  }
  try {
    const { data, error } = await supabase
      .from('accounting_transactions')
      .insert({
        type,
        concept,
        amount: Number(amount),
        date: date || new Date().toISOString().split('T')[0]
      })
      .select()
      .single();

    if (error) {
      if (error.code === '42P01') {
        res.status(400).json({ error: 'La tabla "accounting_transactions" no existe. Por favor, ejecuta la migración SQL en Supabase.' });
        return;
      }
      throw error;
    }
    res.json({ status: 'success', transaction: data });
  } catch (err: any) {
    console.error('Error al insertar transacción:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/transactions/:id', async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('accounting_transactions')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ status: 'success', message: 'Transacción eliminada.' });
  } catch (err: any) {
    console.error('Error al eliminar transacción:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Gestión de Plantillas de Contratos
app.get('/api/admin/contracts', async (req, res): Promise<void> => {
  try {
    const { data: contracts, error } = await supabase
      .from('contract_templates')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      if (error.code === '42P01') {
        res.json({ contracts: [], migration_required: true });
        return;
      }
      throw error;
    }
    res.json({ contracts, migration_required: false });
  } catch (err: any) {
    console.error('Error al listar contratos:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/contracts', async (req, res): Promise<void> => {
  const { title, content } = req.body;
  if (!title || !content) {
    res.status(400).json({ error: 'El título y el contenido son obligatorios.' });
    return;
  }
  try {
    const { data, error } = await supabase
      .from('contract_templates')
      .insert({ title, content })
      .select()
      .single();

    if (error) {
      if (error.code === '42P01') {
        res.status(400).json({ error: 'La tabla "contract_templates" no existe. Por favor, ejecuta la migración SQL en Supabase.' });
        return;
      }
      throw error;
    }
    res.json({ status: 'success', contract: data });
  } catch (err: any) {
    console.error('Error al crear contrato:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/contracts/:id', async (req, res): Promise<void> => {
  const { id } = req.params;
  const { title, content } = req.body;
  try {
    const { data, error } = await supabase
      .from('contract_templates')
      .update({ title, content })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ status: 'success', contract: data });
  } catch (err: any) {
    console.error('Error al actualizar contrato:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/contracts/:id', async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('contract_templates')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ status: 'success', message: 'Contrato eliminado.' });
  } catch (err: any) {
    console.error('Error al eliminar contrato:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Redacción de Contratos por IA (Gemini)
app.post('/api/admin/contracts/generate', async (req, res): Promise<void> => {
  const { prompt } = req.body;
  if (!prompt) {
    res.status(400).json({ error: 'El prompt es obligatorio.' });
    return;
  }

  const apiKey = await getSettingVal('GEMINI_API_KEY');
  if (!apiKey) {
    res.status(400).json({ 
      error: 'La clave GEMINI_API_KEY no está configurada. Por favor, añádela en la pestaña de Ajustes para usar la generación automática de contratos.' 
    });
    return;
  }

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [
          {
            parts: [
              {
                text: `Eres un redactor legal experto. Genera un contrato de prestación de servicios para el SaaS Corandar en base a la siguiente solicitud de indicaciones. Genera únicamente el contrato formal bien redactado en español, sin preámbulos, comentarios, ni etiquetas markdown adicionales. Asegúrate de incluir una cláusula explícita sobre el "Cobro por Uso Adicional" en la que se detalle que, para los planes que no tengan minutos ilimitados (como el Plan Estándar), cualquier consumo de minutos que exceda el límite del plan se facturará a razón de 0.20€ por minuto adicional. Indicaciones: ${prompt}`
              }
            ]
          }
        ]
      }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('No se recibió texto del modelo de IA.');
    }

    res.json({ content: text.trim() });
  } catch (err: any) {
    console.error('Error al generar contrato con Gemini:', err.response?.data || err.message);
    res.status(500).json({ error: 'Error al generar el contrato: ' + (err.response?.data?.error?.message || err.message) });
  }
});

// 5. Obtener el historial de llamadas (Call Logs) para un inquilino
app.get('/api/tenants/:tenant_id/call-logs', async (req, res): Promise<void> => {
  const { tenant_id } = req.params;
  try {
    const { data: logs, error } = await supabase
      .from('call_logs')
      .select('*')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: false });
    
    if (error) {
      if (error.code === '42P01') {
        res.json({ logs: [], migration_required: true });
        return;
      }
      throw error;
    }
    res.json({ logs, migration_required: false });
  } catch (err: any) {
    console.error('Error al obtener call logs:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5B. Eliminar un registro de llamada individual
app.delete('/api/tenants/:tenant_id/call-logs/:log_id', async (req, res): Promise<void> => {
  const { tenant_id, log_id } = req.params;
  try {
    const { error } = await supabase
      .from('call_logs')
      .delete()
      .eq('id', log_id)
      .eq('tenant_id', tenant_id);

    if (error) throw error;
    res.json({ status: 'success', message: 'Registro de llamada eliminado.' });
  } catch (err: any) {
    console.error('Error al eliminar call log:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5C. Limpiar todo el historial de llamadas de un inquilino
app.delete('/api/tenants/:tenant_id/call-logs', async (req, res): Promise<void> => {
  const { tenant_id } = req.params;
  try {
    const { error } = await supabase
      .from('call_logs')
      .delete()
      .eq('tenant_id', tenant_id);

    if (error) throw error;
    res.json({ status: 'success', message: 'Historial de llamadas limpiado.' });
  } catch (err: any) {
    console.error('Error al limpiar call logs:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- DYNAMIC VOICES CATALOG ENDPOINTS ---
const DEFAULT_PREMIUM_VOICES = [
  {
    id: 'cartesia-Sofia',
    name: 'Sofía',
    lang: 'es-LA',
    langName: 'Español Latino',
    gender: 'Femenino',
    provider: 'Cartesia',
    flag: '<img src="https://flagcdn.com/w20/mx.png" style="width: 16px; height: 11px; border-radius: 1px; object-fit: cover; vertical-align: middle; margin-right: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.3);">',
    previewUrl: 'https://retell-utils-public.s3.us-west-2.amazonaws.com/cartesia-5c5ad5e7-1020-476b-8b91-fdcbe9cc313c.mp3',
    retell_agent_id: 'agent_5978b1e3e6d4bbb6ffc928dc6a'
  },
  {
    id: 'retell-Alejandro',
    name: 'Alejandro',
    lang: 'es-MX',
    langName: 'Español Latino',
    gender: 'Masculino',
    provider: 'Platform',
    flag: '<img src="https://flagcdn.com/w20/mx.png" style="width: 16px; height: 11px; border-radius: 1px; object-fit: cover; vertical-align: middle; margin-right: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.3);">',
    previewUrl: 'https://retell-utils-public.s3.us-west-2.amazonaws.com/minimax-Alejandro.mp3',
    retell_agent_id: 'agent_5978b1e3e6d4bbb6ffc928dc6a'
  },
  {
    id: 'cartesia-Elena',
    name: 'Elena',
    lang: 'es-ES',
    langName: 'Español España',
    gender: 'Femenino',
    provider: 'Cartesia',
    flag: '<img src="https://flagcdn.com/w20/es.png" style="width: 16px; height: 11px; border-radius: 1px; object-fit: cover; vertical-align: middle; margin-right: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.3);">',
    previewUrl: 'https://retell-utils-public.s3.us-west-2.amazonaws.com/cartesia-cefcb124-080b-4655-b31f-932f3ee743de.mp3',
    retell_agent_id: 'agent_3bc19d57c787b2b9f1a00518da'
  },
  {
    id: 'cartesia-Manuel',
    name: 'Manuel',
    lang: 'es-ES',
    langName: 'Español España',
    gender: 'Masculino',
    provider: 'Cartesia',
    flag: '<img src="https://flagcdn.com/w20/es.png" style="width: 16px; height: 11px; border-radius: 1px; object-fit: cover; vertical-align: middle; margin-right: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.3);">',
    previewUrl: 'https://retell-utils-public.s3.us-west-2.amazonaws.com/cartesia-b5aa8098-49ef-475d-89b0-c9262ecf33fd.mp3',
    retell_agent_id: 'agent_d78fee2119096b895e0e851873'
  },
  {
    id: 'custom_voice_c3e5212df87e5341a06ad66e66',
    name: 'Gabriela',
    lang: 'es-ES',
    langName: 'Español España',
    gender: 'Femenino',
    provider: 'ElevenLabs',
    flag: '<img src="https://flagcdn.com/w20/es.png" style="width: 16px; height: 11px; border-radius: 1px; object-fit: cover; vertical-align: middle; margin-right: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.3);">',
    previewUrl: '/gabriela_spanish.mp3',
    retell_agent_id: 'agent_5978b1e3e6d4bbb6ffc928dc6a'
  },
  {
    id: 'cartesia-Sarah',
    name: 'Sarah',
    lang: 'en-US',
    langName: 'Inglés EE.UU.',
    gender: 'Femenino',
    provider: 'Cartesia',
    flag: '<img src="https://flagcdn.com/w20/us.png" style="width: 16px; height: 11px; border-radius: 1px; object-fit: cover; vertical-align: middle; margin-right: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.3);">',
    previewUrl: 'https://retell-utils-public.s3.us-west-2.amazonaws.com/cartesia-156fb8d2-335b-4950-9cb3-a2d33befec77.mp3',
    retell_agent_id: 'agent_sarah_default_retell_id'
  },
  {
    id: 'minimax-Daniel',
    name: 'Daniel',
    lang: 'en-US',
    langName: 'Inglés EE.UU.',
    gender: 'Masculino',
    provider: 'Minimax',
    flag: '<img src="https://flagcdn.com/w20/us.png" style="width: 16px; height: 11px; border-radius: 1px; object-fit: cover; vertical-align: middle; margin-right: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.3);">',
    previewUrl: 'https://retell-utils-public.s3.us-west-2.amazonaws.com/daniel.mp3',
    retell_agent_id: 'agent_daniel_default_retell_id'
  }
];

// GET: Obtener catálogo de voces
app.get('/api/voices-catalog', async (req, res): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'PREMIUM_VOICES_CATALOG')
      .maybeSingle();

    if (error && error.code !== '42P01') throw error;

    if (!data || !data.value) {
      // Si la clave no existe, inicializar con las voces por defecto
      const { error: insErr } = await supabase
        .from('settings')
        .upsert({
          key: 'PREMIUM_VOICES_CATALOG',
          value: JSON.stringify(DEFAULT_PREMIUM_VOICES)
        });

      if (insErr) throw insErr;
      res.json(DEFAULT_PREMIUM_VOICES);
    } else {
      res.json(JSON.parse(data.value));
    }
  } catch (err: any) {
    console.error('Error al obtener voces del catálogo:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST: Añadir o actualizar una voz del catálogo
app.post('/api/voices-catalog', async (req, res): Promise<void> => {
  try {
    const newVoice = req.body;
    if (!newVoice.id || !newVoice.name || !newVoice.lang) {
      res.status(400).json({ error: 'Faltan campos requeridos (id, name, lang)' });
      return;
    }

    const { data, error } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'PREMIUM_VOICES_CATALOG')
      .maybeSingle();

    if (error) throw error;

    let catalog = data && data.value ? JSON.parse(data.value) : [...DEFAULT_PREMIUM_VOICES];
    
    // Eliminar si ya existe con ese ID para evitar duplicados
    catalog = catalog.filter((v: any) => v.id !== newVoice.id);
    catalog.push(newVoice);

    const { error: updErr } = await supabase
      .from('settings')
      .upsert({
        key: 'PREMIUM_VOICES_CATALOG',
        value: JSON.stringify(catalog)
      });

    if (updErr) throw updErr;
    res.json({ status: 'success', catalog });
  } catch (err: any) {
    console.error('Error al añadir voz al catálogo:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE: Eliminar una voz del catálogo
app.delete('/api/voices-catalog/:id', async (req, res): Promise<void> => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'PREMIUM_VOICES_CATALOG')
      .maybeSingle();

    if (error) throw error;

    let catalog = data && data.value ? JSON.parse(data.value) : [...DEFAULT_PREMIUM_VOICES];
    catalog = catalog.filter((v: any) => v.id !== id);

    const { error: updErr } = await supabase
      .from('settings')
      .upsert({
        key: 'PREMIUM_VOICES_CATALOG',
        value: JSON.stringify(catalog)
      });

    if (updErr) throw updErr;
    res.json({ status: 'success', catalog });
  } catch (err: any) {
    console.error('Error al eliminar voz del catálogo:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET: Obtener lista de agentes reales desde Retell AI
app.get('/api/retell-agents', async (req, res): Promise<void> => {
  try {
    const apiKey = await getSettingVal('RETELL_API_KEY');
    if (!apiKey || apiKey === 'YOUR_RETELL_API_KEY') {
      res.status(400).json({ error: 'La API Key de Retell no está configurada.' });
      return;
    }

    console.log('[Catalog API] Listando agentes de Retell AI...');
    const response = await axios.get('https://api.retellai.com/list-agents', {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    res.json(response.data || []);
  } catch (err: any) {
    console.error('Error al listar agentes de Retell:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// POST: Actualizar temporalmente la voz de un agente de Retell AI en caliente para pruebas
app.post('/api/admin/update-agent-voice-temp', async (req, res): Promise<void> => {
  const { agent_id, voice_id, responsiveness, voice_speed, voice_temperature } = req.body;
  if (!agent_id) {
    res.status(400).json({ error: 'Faltan campos requeridos (agent_id).' });
    return;
  }

  try {
    const apiKey = await getSettingVal('RETELL_API_KEY');
    if (!apiKey || apiKey === 'YOUR_RETELL_API_KEY' || apiKey.trim() === '') {
      res.status(400).json({ error: 'La clave RETELL_API_KEY no está configurada.' });
      return;
    }

    console.log(`[Hot Voice Update] Actualizando agente ${agent_id} (Voz: ${voice_id || 'no_change'}, Responsiveness: ${responsiveness}, Speed: ${voice_speed}, Temp: ${voice_temperature}) en Retell AI...`);
    
    const patchPayload: any = {};
    if (voice_id && !voice_id.startsWith('custom_voice_')) {
      patchPayload.voice_id = voice_id;
    }
    if (responsiveness !== undefined) {
      patchPayload.responsiveness = Number(responsiveness);
    }
    if (voice_speed !== undefined) {
      patchPayload.voice_speed = Number(voice_speed);
    }
    if (voice_temperature !== undefined) {
      patchPayload.voice_temperature = Number(voice_temperature);
    }
    patchPayload.interruption_sensitivity = 0.8;

    const response = await axios.patch(
      `https://api.retellai.com/update-agent/${agent_id}`,
      patchPayload,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ status: 'success', agent: response.data });
  } catch (err: any) {
    const errStatus = err.response?.status;
    const errMsg = err.response?.data?.message || err.message || '';
    console.error('Error al actualizar voz del agente en Retell:', err.response?.data || err.message);
    
    if (errStatus === 422 || errMsg.includes('published agent') || errMsg.includes('Cannot update published agent')) {
      res.json({ 
        status: 'warning', 
        message: 'El agente está publicado en Retell AI y es inmutable. Para aplicar los cambios de voz y configuración, despublícalo o crea un borrador en el panel de Retell AI.' 
      });
    } else {
      res.status(500).json({ error: errMsg });
    }
  }
});

// POST: Sincronizar agente de voz de Retell AI con los datos del inquilino
app.post('/api/admin/sync-retell', async (req, res): Promise<void> => {
  const { tenant_id } = req.body;
  if (!tenant_id) {
    res.status(400).json({ error: 'El tenant_id es obligatorio.' });
    return;
  }

  try {
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', tenant_id)
      .single();

    if (error || !tenant) {
      res.status(404).json({ error: 'Inquilino no encontrado.' });
      return;
    }

    let webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
    if (!webhookBaseUrl) {
      const host = req.get('host') || '';
      const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
      webhookBaseUrl = `${protocol}://${host}`;
    }

    await syncTenantWithRetell(tenant, webhookBaseUrl);
    res.json({ success: true, message: 'Agente de Retell AI sincronizado exitosamente.' });
  } catch (err: any) {
    console.error('Error al sincronizar inquilino con Retell:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 6. Obtener ajustes dinámicos de API
app.get('/api/admin/settings', async (req, res): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('*');
    
    if (error) {
      if (error.code === '42P01') {
        res.json({ settings: [], migration_required: true });
        return;
      }
      throw error;
    }
    res.json({ settings: data || [], migration_required: false });
  } catch (err: any) {
    console.error('Error al obtener ajustes:', err);
    res.status(500).json({ error: err.message });
  }
});

// Ruta temporal para ejecutar la migración DDL de Supabase desde el propio servidor de Render
app.post('/api/admin/run-migration', async (req, res): Promise<void> => {
  console.log('[Migration Endpoint] Iniciando alter table en Supabase...');
  const { Client } = require('pg');
  const projectRef = 'vnlbxfhzfuamzyqylkvd';
  const password = '1S67.!3CFitNmj';
  let directErrorMsg = '';

  // Opción 1: Conexión Directa (Puerto 5432) - Evita el circuit breaker de PgBouncer
  try {
    console.log('[Migration Endpoint] Intentando conexión DIRECTA (puerto 5432)...');
    const client = new Client({
      host: `db.${projectRef}.supabase.co`,
      port: 5432,
      database: 'postgres',
      user: 'postgres',
      password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000
    });

    await client.connect();
    console.log('[Migration Endpoint] ¡Conexión DIRECTA exitosa!');
    await client.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS email_notifications_enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS client_whatsapp_enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS client_email_enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS client_enable_no_show_deposits BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS client_enable_multi_professional BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS whatsapp_immediate_notification_enabled BOOLEAN DEFAULT TRUE;
      NOTIFY pgrst, 'reload schema';
    `);
    console.log('[Migration Endpoint] ✅ Columnas añadidas con éxito (Conexión Directa).');
    await client.end();
    res.json({ success: true, message: 'Migración ejecutada con éxito mediante conexión DIRECTA.' });
    return;
  } catch (directErr: any) {
    console.warn('[Migration Endpoint] Falló la conexión directa:', directErr.message);
    directErrorMsg = directErr.message;
  }

  // Opción 2: Conexión por Pooler (Puerto 6543) - Fallback
  try {
    console.log('[Migration Endpoint] Intentando conexión vía POOLER (puerto 6543)...');
    const client = new Client({
      host: 'aws-0-eu-west-1.pooler.supabase.com',
      port: 6543,
      database: 'postgres',
      user: `postgres.${projectRef}`,
      password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000
    });

    await client.connect();
    console.log('[Migration Endpoint] ¡Conexión por POOLER exitosa!');
    await client.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS email_notifications_enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS client_whatsapp_enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS client_email_enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS client_enable_no_show_deposits BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS client_enable_multi_professional BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS whatsapp_immediate_notification_enabled BOOLEAN DEFAULT TRUE;
      NOTIFY pgrst, 'reload schema';
    `);
    console.log('[Migration Endpoint] ✅ Columnas añadidas con éxito (Conexión Pooler).');
    await client.end();
    res.json({ success: true, message: 'Migración ejecutada con éxito mediante conexión por POOLER.' });
    return;
  } catch (poolErr: any) {
    console.error('[Migration Endpoint] Falló también la conexión por pooler:', poolErr.message);
    res.status(500).json({ 
      error: `La migración falló. Error Directo: ${directErrorMsg}. Error Pooler: ${poolErr.message}` 
    });
  }
});

// 7. Guardar ajustes dinámicos de API
app.post('/api/admin/settings', async (req, res): Promise<void> => {
  const { settings } = req.body;
  if (!settings || !Array.isArray(settings)) {
    res.status(400).json({ error: 'Formato incorrecto. Se requiere un array de ajustes.' });
    return;
  }
  try {
    const upsertData = settings.map((s: any) => ({
      key: s.key,
      value: s.value
    }));
    
    const { error } = await supabase
      .from('settings')
      .upsert(upsertData, { onConflict: 'key' });
      
    if (error) throw error;
    res.json({ status: 'success', message: 'Ajustes guardados correctamente.' });
  } catch (err: any) {
    console.error('Error al guardar ajustes:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8. Iniciar llamada de prueba por WebRTC para el administrador
app.post('/api/admin/test-agent-call', async (req, res): Promise<void> => {
  const { agent_id } = req.body;
  if (!agent_id) {
    res.status(400).json({ error: 'El agent_id es obligatorio.' });
    return;
  }
  try {
    const apiKey = await getSettingVal('RETELL_API_KEY');
    if (!apiKey || apiKey === 'YOUR_RETELL_API_KEY' || apiKey.trim() === '') {
      res.status(400).json({ error: 'La clave RETELL_API_KEY no está configurada. Por favor, añádela en la pestaña de Ajustes.' });
      return;
    }
    
    console.log(`[Test Call] Solicitando token de llamada web para el agente: ${agent_id}...`);
    const response = await axios.post(
      'https://api.retellai.com/v2/create-web-call',
      { agent_id },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (!response.data || !response.data.access_token) {
      throw new Error('No se recibió el token de acceso de Retell.');
    }
    
    res.json({
      access_token: response.data.access_token,
      call_id: response.data.call_id
    });
  } catch (err: any) {
    console.error('Error al iniciar llamada de prueba:', err.response?.data || err.message);
    res.status(500).json({ error: 'Error al iniciar llamada de prueba: ' + (err.response?.data?.error?.message || err.message) });
  }
});

// 8.1 Iniciar llamada de prueba por WebRTC para el cliente
app.post('/api/client/test-agent-call', async (req, res): Promise<void> => {
  const { tenant_id } = req.body;
  if (!tenant_id) {
    res.status(400).json({ error: 'El tenant_id es obligatorio.' });
    return;
  }
  try {
    const { data: tenant, error: tErr } = await supabase
      .from('tenants')
      .select('retell_agent_id')
      .eq('id', tenant_id)
      .single();

    if (tErr || !tenant || !tenant.retell_agent_id) {
      res.status(404).json({ error: 'No se encontró un Agente de Voz configurado para este negocio.' });
      return;
    }

    const apiKey = await getSettingVal('RETELL_API_KEY');
    if (!apiKey || apiKey === 'YOUR_RETELL_API_KEY' || apiKey.trim() === '') {
      res.status(400).json({ error: 'La clave RETELL_API_KEY no está configurada.' });
      return;
    }

    console.log(`[Client Test Call] Solicitando token de llamada web para el agente: ${tenant.retell_agent_id}...`);
    const response = await axios.post(
      'https://api.retellai.com/v2/create-web-call',
      { agent_id: tenant.retell_agent_id },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.data || !response.data.access_token) {
      throw new Error('No se recibió el token de acceso de Retell.');
    }

    res.json({
      access_token: response.data.access_token,
      call_id: response.data.call_id
    });
  } catch (err: any) {
    console.error('Error al iniciar llamada de prueba de cliente:', err.response?.data || err.message);
    res.status(500).json({ error: 'Error al iniciar llamada de prueba: ' + (err.response?.data?.error?.message || err.message) });
  }
});

// 8.2 Probar envío de WhatsApp (Twilio/QR)
app.post('/api/test-whatsapp', async (req, res): Promise<void> => {
  const { phone, message, tenant_id } = req.body;
  if (!phone || !message) {
    res.status(400).json({ error: 'El teléfono y el mensaje son obligatorios.' });
    return;
  }
  try {
    const success = await sendWhatsAppMessage(phone, message, tenant_id);
    if (success) {
      res.json({ status: 'success', message: 'Mensaje de WhatsApp de prueba enviado correctamente.' });
    } else {
      res.status(500).json({ error: 'Fallo al enviar el mensaje de WhatsApp. Revisa las credenciales y configuración del proveedor en los Ajustes.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8.3 Obtener logs de depuración del servicio de WhatsApp
app.get('/api/debug/logs', (req, res): void => {
  res.json({ logs: debugLogs });
});

// WhatsApp Web endpoints para clientes
app.get('/api/client/whatsapp/status', async (req, res): Promise<void> => {
  const tenantId = (req.query.tenant_id || req.query.tenantId) as string;
  if (!tenantId) {
    res.status(400).json({ error: 'El parámetro tenant_id es requerido.' });
    return;
  }

  try {
    const statusInfo = getWhatsAppSessionStatus(tenantId);
    
    // Si está desconectado y el proveedor es 'qr', intentamos inicializar de fondo para que genere el QR
    if (statusInfo.status === 'disconnected') {
      const { data: tenant } = await supabase
        .from('tenants')
        .select('client_whatsapp_provider')
        .eq('id', tenantId)
        .maybeSingle();

      if (tenant && (tenant.client_whatsapp_provider === 'qr' || !tenant.client_whatsapp_provider)) {
        initWhatsAppWebSession(tenantId).catch(err => {
          console.error(`Error al autoinicializar sesión de WhatsApp para ${tenantId}:`, err.message);
        });
        res.json({ status: 'connecting' });
        return;
      }
    }

    res.json(statusInfo);
  } catch (err: any) {
    console.error(`Error al obtener estado de WhatsApp para tenant ${tenantId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/client/whatsapp/connect', async (req, res): Promise<void> => {
  const tenantId = req.body.tenant_id || req.body.tenantId;
  if (!tenantId) {
    res.status(400).json({ error: 'El parámetro tenant_id es requerido.' });
    return;
  }

  try {
    console.log(`[WhatsApp Web API] Conectando sesión de WhatsApp para tenant ${tenantId}...`);
    initWhatsAppWebSession(tenantId).catch(err => {
      console.error(`Error al iniciar sesión de WhatsApp para ${tenantId}:`, err.message);
    });
    res.json({ status: 'connecting' });
  } catch (err: any) {
    console.error(`Error al conectar WhatsApp para tenant ${tenantId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/client/whatsapp/disconnect', async (req, res): Promise<void> => {
  const tenantId = req.body.tenant_id || req.body.tenantId;
  if (!tenantId) {
    res.status(400).json({ error: 'El parámetro tenant_id es requerido.' });
    return;
  }

  try {
    console.log(`[WhatsApp Web API] Desconectando/Desvinculando WhatsApp para tenant ${tenantId}...`);
    await disconnectWhatsAppWebSession(tenantId);
    res.json({ status: 'disconnected' });
  } catch (err: any) {
    console.error(`Error al desconectar WhatsApp para tenant ${tenantId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 9. Simular envío de contrato por email
app.post('/api/admin/tenants/:id/send-contract', async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    const nowStr = new Date().toISOString();
    const { data: updatedTenant, error } = await supabase
      .from('tenants')
      .update({
        contract_email_sent: true,
        contract_email_sent_at: nowStr
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`[Email Contract Simulation] Contrato enviado a ${updatedTenant.email} para el negocio ${updatedTenant.business_name} el ${nowStr}`);
    res.json(updatedTenant);
  } catch (err: any) {
    console.error('Error al enviar contrato por email:', err);
    res.status(500).json({ error: err.message });
  }
});

// 10. Firma digital del cliente a distancia
app.post('/api/client/tenants/:id/sign-contract', async (req, res): Promise<void> => {
  const { id } = req.params;
  const { signature_name } = req.body;

  if (!signature_name || signature_name.trim() === '') {
    res.status(400).json({ error: 'El nombre de firma digital es obligatorio.' });
    return;
  }

  try {
    const nowStr = new Date().toISOString();
    const { data: updatedTenant, error } = await supabase
      .from('tenants')
      .update({
        is_signed_by_client: true,
        client_signature_name: signature_name.trim(),
        signed_by_client_at: nowStr
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    console.log(`[Digital Signature] Cliente ${updatedTenant.business_name} firmó digitalmente a distancia con nombre "${signature_name.trim()}" el ${nowStr}`);
    res.json(updatedTenant);
  } catch (err: any) {
    console.error('Error en firma digital del cliente:', err);
    res.status(500).json({ error: err.message });
  }
});

// 11. Cambio de PIN del cliente autónomo
app.post('/api/client/tenants/:id/change-pin', async (req, res): Promise<void> => {
  const { id } = req.params;
  const { new_pin } = req.body;

  if (!new_pin || new_pin.length !== 4 || isNaN(Number(new_pin))) {
    res.status(400).json({ error: 'El PIN debe ser un código de 4 dígitos.' });
    return;
  }

  try {
    const { data, error } = await supabase
      .from('tenants')
      .update({ admin_pin: new_pin })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, tenant: data });
  } catch (err: any) {
    console.error('Error al cambiar el PIN del cliente:', err);
    res.status(500).json({ error: err.message });
  }
});

// Registrar rutas de webhook
app.use('/api/webhook', webhookRouter);



// Tarea en segundo plano para enviar recordatorios automáticos de WhatsApp (Twilio)
setInterval(async () => {
  try {
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('*, tenants(*)')
      .eq('status', 'confirmed')
      .eq('whatsapp_reminder_sent', false);

    if (error) {
      console.error('[WhatsApp Reminder] Error al consultar citas para recordatorios:', error.message);
      return;
    }

    if (appointments && appointments.length > 0) {
      const now = Date.now();
      for (const app of appointments) {
        const tenant = app.tenants;
        if (!tenant || !tenant.whatsapp_reminders_enabled) continue;

        const reminderHours = tenant.whatsapp_reminder_hours !== undefined && tenant.whatsapp_reminder_hours !== null 
          ? Number(tenant.whatsapp_reminder_hours) 
          : 24;
        
        const apptTime = new Date(app.date_time).getTime();
        const triggerTime = apptTime - reminderHours * 60 * 60 * 1000;

        // Si ya estamos dentro del ventana de envío (e.g. faltan menos de X horas para la cita)
        if (now >= triggerTime) {
          // Asegurarnos de que no sea una cita pasada (e.g. no enviar recordatorios para citas de hace días)
          if (now < apptTime + 30 * 60 * 1000) {
            console.log(`[WhatsApp Reminder] Enviando recordatorio para la cita ID: ${app.id} (${app.patient_name}) en ${tenant.business_name} (Anticipación: ${reminderHours} horas)...`);
            
            // Formatear fecha y hora humana
            const dateObj = new Date(app.date_time);
            const dateStr = dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const timeStr = dateObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
            
            const msg = `Recordatorio de Cita 🔔\n\nHola ${app.patient_name}, le recordamos su cita programada en ${tenant.business_name}.\n\n🔹 Servicio: ${app.specialty}\n🔹 Fecha: ${dateStr}\n🔹 Hora: ${timeStr}\n\n¡Le esperamos!`;
            
            const success = await sendWhatsAppMessage(app.patient_phone, msg, tenant.id);
            if (success) {
              console.log(`[WhatsApp Reminder] Recordatorio enviado correctamente a ${app.patient_phone}.`);
            } else {
              console.warn(`[WhatsApp Reminder] Falló el envío del recordatorio a ${app.patient_phone}.`);
            }
          }

          // Marcar como enviado de todas formas para no procesarlo repetidamente
          await supabase
            .from('appointments')
            .update({ whatsapp_reminder_sent: true })
            .eq('id', app.id);
        }
      }
    }
  } catch (err: any) {
    console.error('[WhatsApp Reminder] Error crítico en la tarea de recordatorios:', err.message);
  }
}, 5 * 60 * 1000); // Ejecutar cada 5 minutos

// Arrancar el servidor
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(` Servidor SanaSalud escuchando en: http://localhost:${PORT}`);
  console.log(`========================================\n`);
  
  // Arrancar automáticamente las sesiones activas de WhatsApp Web en segundo plano
  autoStartActiveSessions().catch(err => {
    console.error('[WhatsApp Web Boot] Error al arrancar sesiones de WhatsApp:', err.message);
  });
});
