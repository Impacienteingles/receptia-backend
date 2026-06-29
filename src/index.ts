import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import nodemailer from 'nodemailer';
const pdf = require('pdf-parse');
import webhookRouter from './routes/webhook';
import prospectingRouter from './routes/prospecting';
import pmsRouter from './routes/pms';
import campaignsRouter from './routes/campaigns';
import comercialesRouter from './routes/comerciales';
import comercialPanelRouter from './routes/comercial-panel';
import optimizationRouter from './routes/optimization';
import referralsRouter from './routes/referrals';
import { getAuthUrl, getTokensFromCode, updateAppointment, deleteAppointment } from './services/googleCalendar';
import { supabase, getSettingVal, clearSettingsCache } from './services/supabase';
import { syncTenantWithRetell, compileSystemPrompt, formatVoiceId, deleteRetellAgent, resolveAgentName } from './services/retell';
import { createStripeCheckoutSession, createStripePortalSession, getStripeClient, createStripeAddonCheckoutSession } from './services/stripe';
import axios from 'axios';
import { sendWhatsAppMessage } from './services/whatsapp';
import { processChatbotMessage } from './services/chatbot';
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
  limit: '15mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf;
  }
}));

// Servir archivos estáticos del panel de control con control de caché desactivado para archivos HTML
app.use(express.static(path.join(process.cwd(), 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
  }
}));

// Helper functions for storing block_admin_access in settings table
async function getBlockAdminAccess(tenantId: string): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const { data } = await supabase
      .from('settings')
      .select('value')
      .eq('key', `block_admin_access_${tenantId}`)
      .maybeSingle();
    return data?.value === 'true';
  } catch (e) {
    return false;
  }
}

async function setBlockAdminAccess(tenantId: string, value: boolean): Promise<void> {
  if (!tenantId) return;
  try {
    await supabase
      .from('settings')
      .upsert({
        key: `block_admin_access_${tenantId}`,
        value: value ? 'true' : 'false'
      });
  } catch (e) {
    console.error(`Error writing block_admin_access_${tenantId} to settings:`, e);
  }
}

// Endpoints REST de la Plataforma SaaS

// 1. Obtener detalles de un inquilino por email o ID, o listar todos si no se especifican filtros
app.get('/api/tenants', async (req, res): Promise<void> => {
  const { email, id } = req.query;
  try {
    // Fetch all block_admin_access settings from settings table
    const { data: blockedSettings } = await supabase
      .from('settings')
      .select('key, value')
      .like('key', 'block_admin_access_%');
    
    const blockedTenantIds = new Set(
      (blockedSettings || [])
        .filter(s => s.value === 'true')
        .map(s => s.key.replace('block_admin_access_', ''))
    );

    let query = supabase.from('tenants').select('*');
    const mapTenant = (t: any) => {
      if (!t) return t;
      let workingHoursObj = t.working_hours;
      if (typeof workingHoursObj === 'string') {
        try { workingHoursObj = JSON.parse(workingHoursObj); } catch (e) {}
      }
      t.client_enable_multi_professional = workingHoursObj?.client_enable_multi_professional !== false;
      t.client_enable_no_show_deposits = workingHoursObj?.client_enable_no_show_deposits !== false;
      t.whatsapp_immediate_notification_enabled = t.whatsapp_immediate_notification_enabled !== undefined && t.whatsapp_immediate_notification_enabled !== null
        ? t.whatsapp_immediate_notification_enabled
        : (workingHoursObj?.whatsapp_immediate_notification_enabled !== false);
        
      t.block_admin_access = blockedTenantIds.has(t.id);

      // Privacy Block: if block_admin_access is enabled
      const reqPin = req.query.pin || req.headers['x-client-pin'];
      const isClientRequest = reqPin && reqPin === t.admin_pin;
      
      if (t.block_admin_access && !isClientRequest) {
        // Redact sensitive details for admin
        t.admin_pin = '****';
        t.custom_instructions = 'Acceso bloqueado por privacidad del cliente';
        t.business_description = 'Acceso bloqueado por privacidad del cliente';
        t.pricing_details = 'Acceso bloqueado por privacidad del cliente';
        t.specialties = [];
        t.vacation_message = 'Acceso bloqueado';
        t.knowledge_base_content = 'Acceso bloqueado';
        t.admin_access_blocked = true;
      }
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

// Nuevo endpoint para autenticación de inquilinos con Email y PIN
app.post('/api/auth/login', async (req, res): Promise<void> => {
  const { email, pin } = req.body;
  if (!email || !pin) {
    res.status(400).json({ error: 'El email y el PIN son obligatorios.' });
    return;
  }

  try {
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('id, admin_pin, business_name')
      .eq('email', email.trim().toLowerCase())
      .eq('is_archived', false)
      .maybeSingle();

    if (error) throw error;

    if (!tenant) {
      res.status(404).json({ error: 'El correo electrónico no está registrado o el cliente está archivado.' });
      return;
    }

    if (!tenant.admin_pin) {
      // El inquilino se ha registrado pero aún no ha configurado su PIN
      res.status(400).json({ 
        error: 'Tu cuenta aún no tiene un PIN configurado. Por favor, accede usando el enlace directo enviado a tu correo o contacta con el soporte para establecer tu primer PIN.',
        needs_initial_setup: true,
        tenant_id: tenant.id
      });
      return;
    }

    if (tenant.admin_pin !== pin.trim()) {
      res.status(401).json({ error: 'El PIN de acceso introducido es incorrecto.' });
      return;
    }

    res.json({ success: true, tenant_id: tenant.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para recuperación automática de PIN mediante envío de correo SMTP
app.post('/api/auth/recover-pin', async (req, res): Promise<void> => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: 'El correo electrónico es obligatorio.' });
    return;
  }

  try {
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('id, admin_pin, business_name')
      .eq('email', email.trim().toLowerCase())
      .eq('is_archived', false)
      .maybeSingle();

    if (error) throw error;

    if (!tenant) {
      res.status(404).json({ error: 'El correo electrónico introducido no está registrado o la cuenta está inactiva.' });
      return;
    }

    if (!tenant.admin_pin) {
      res.status(400).json({ error: 'Esta cuenta aún no tiene un PIN configurado en el sistema.' });
      return;
    }

    // Configurar transporte SMTP modular de Nodemailer reutilizando las variables del .env
    let transporter = null;
    let mailFrom = '';

    if (process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS) {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 5000
      });
      mailFrom = process.env.SMTP_USER;
    } else if (process.env.GOOGLE_EMAIL && process.env.GOOGLE_PASSWORD) {
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.GOOGLE_EMAIL,
          pass: process.env.GOOGLE_PASSWORD
        },
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 5000
      });
      mailFrom = process.env.GOOGLE_EMAIL;
    }

    if (transporter && mailFrom) {
      const mailOptions = {
        from: `"Soporte Receptia" <${mailFrom}>`,
        to: email.trim().toLowerCase(),
        subject: `Recuperación de PIN - Receptia`,
        html: `
          <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 30px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h2 style="color: #7c3aed; margin: 0; font-size: 24px;">Receptia Mobile</h2>
              <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Recuperación de credenciales</p>
            </div>
            <div style="font-size: 16px; color: #1e293b; line-height: 1.6; margin-bottom: 24px;">
              <p>Hola, <strong>${tenant.business_name}</strong>:</p>
              <p>Hemos recibido una solicitud para recuperar tu PIN de acceso al panel de cliente de Receptia Mobile.</p>
              <div style="text-align: center; background-color: #f8fafc; border: 1px solid #cbd5e1; padding: 20px; border-radius: 12px; margin: 24px 0;">
                <p style="font-size: 13px; color: #64748b; margin: 0; text-transform: uppercase; letter-spacing: 0.05em;">Tu PIN de acceso es:</p>
                <p style="font-size: 36px; font-weight: bold; color: #1e293b; letter-spacing: 0.1em; margin: 8px 0 0 0;">${tenant.admin_pin}</p>
              </div>
              <p style="font-size: 14px; color: #64748b;">Si no has solicitado esta recuperación, por favor te sugerimos cambiar tu PIN desde el panel de control o ponerte en contacto con soporte.</p>
            </div>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin-bottom: 20px;" />
            <div style="text-align: center; font-size: 12px; color: #94a3b8;">
              <p>© 2026 Receptia. Todos los derechos reservados.</p>
            </div>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
      res.json({ success: true, message: 'Tu PIN de acceso ha sido enviado automáticamente a tu correo electrónico registrado.' });
    } else {
      res.status(500).json({ error: 'El servicio de envío de correos no está configurado en el servidor.' });
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
    client_enable_no_show_deposits,
    whatsapp_immediate_notification_enabled,
    business_sector,
    block_admin_access,
    personality_tone,
    personality_focus,
    personality_speed,
    text_back_enabled,
    text_back_message,
    chatbot_enabled,
    chatbot_welcome_message,
    agenda_optimization_enabled
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
    let blockAdminAccessVal: boolean | undefined = undefined;
    if (block_admin_access !== undefined) blockAdminAccessVal = !!block_admin_access;
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
    if (business_sector !== undefined) tenantData.business_sector = business_sector;
    if (personality_tone !== undefined) tenantData.personality_tone = Number(personality_tone);
    if (personality_focus !== undefined) tenantData.personality_focus = Number(personality_focus);
    if (personality_speed !== undefined) tenantData.personality_speed = Number(personality_speed);
    if (text_back_enabled !== undefined) tenantData.text_back_enabled = !!text_back_enabled;
    if (text_back_message !== undefined) tenantData.text_back_message = text_back_message;
    if (chatbot_enabled !== undefined) tenantData.chatbot_enabled = !!chatbot_enabled;
    if (chatbot_welcome_message !== undefined) tenantData.chatbot_welcome_message = chatbot_welcome_message;
    if (agenda_optimization_enabled !== undefined) tenantData.agenda_optimization_enabled = !!agenda_optimization_enabled;
    
    // Safely check if database contains the column to prevent query crashes
    const hasImmediateCol = existing ? ('whatsapp_immediate_notification_enabled' in existing) : false;
    if (whatsapp_immediate_notification_enabled !== undefined && hasImmediateCol) {
      tenantData.whatsapp_immediate_notification_enabled = !!whatsapp_immediate_notification_enabled;
    }
    if (client_enable_multi_professional !== undefined || client_enable_no_show_deposits !== undefined || whatsapp_immediate_notification_enabled !== undefined) {
      let workingHoursObj: any = {};
      if (existing && existing.working_hours) {
        workingHoursObj = typeof existing.working_hours === 'string' 
          ? JSON.parse(existing.working_hours) 
          : existing.working_hours;
      }
      if (client_enable_multi_professional !== undefined) {
        workingHoursObj.client_enable_multi_professional = !!client_enable_multi_professional;
      }
      if (client_enable_no_show_deposits !== undefined) {
        workingHoursObj.client_enable_no_show_deposits = !!client_enable_no_show_deposits;
      }
      if (whatsapp_immediate_notification_enabled !== undefined) {
        workingHoursObj.whatsapp_immediate_notification_enabled = !!whatsapp_immediate_notification_enabled;
      }
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
      if (!attemptData.admin_pin) {
        attemptData.admin_pin = '0000';
      }
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
    if (savedTenant) {
      syncTenantWithRetell(savedTenant, webhookBaseUrl)
        .then(() => console.log(`Sincronización completada con Retell AI para ${email}`))
        .catch(err => console.error(`Error en segundo plano al sincronizar ${email} con Retell AI:`, err.message));

      if (blockAdminAccessVal !== undefined) {
        await setBlockAdminAccess(savedTenant.id, blockAdminAccessVal);
        savedTenant.block_admin_access = blockAdminAccessVal;
      } else {
        savedTenant.block_admin_access = await getBlockAdminAccess(savedTenant.id);
      }
    }

    res.json(savedTenant);
  } catch (err: any) {
    console.error('Error al guardar inquilino:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Listar citas de un inquilino
app.get('/api/appointments', async (req, res): Promise<void> => {
  const { tenant_id, pin } = req.query;
  if (!tenant_id) {
    res.status(400).json({ error: 'Se requiere el parámetro tenant_id.' });
    return;
  }
  
  try {
    // Check if the tenant has blocked admin access
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('admin_pin')
      .eq('id', tenant_id)
      .single();

    if (tenantErr || !tenant) {
      res.status(404).json({ error: 'Inquilino no encontrado.' });
      return;
    }

    const isBlocked = await getBlockAdminAccess(tenant_id as string);
    if (isBlocked) {
      const reqPin = pin || req.headers['x-client-pin'];
      if (!reqPin || reqPin !== tenant.admin_pin) {
        res.status(403).json({ error: 'El cliente ha bloqueado el acceso del administrador al historial de citas.' });
        return;
      }
    }

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

app.post('/api/admin/tenants/:id/refund', async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    const { data: tenant, error: getError } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (getError) throw getError;
    if (!tenant) {
      res.status(404).json({ error: 'Inquilino no encontrado.' });
      return;
    }

    if (!tenant.stripe_customer_id) {
      res.status(400).json({ error: 'El cliente no tiene un ID de cliente de Stripe asociado.' });
      return;
    }

    const stripe = await getStripeClient();

    // 1. Encontrar la última transacción cobrada (charge) exitosa
    const charges = await stripe.charges.list({
      customer: tenant.stripe_customer_id,
      limit: 10
    });

    const refundableCharge = charges.data.find(c => c.paid && !c.refunded && c.status === 'succeeded');

    if (!refundableCharge) {
      res.status(400).json({ error: 'No se encontró ningún cargo reembolsable en Stripe para este cliente.' });
      return;
    }

    // 2. Ejecutar reembolso en Stripe
    const refund = await stripe.refunds.create({
      charge: refundableCharge.id
    });

    console.log(`[Stripe] Reembolso emitido para la carga ${refundableCharge.id}. ID Reembolso: ${refund.id}`);

    // 3. Cancelar la suscripción activa si existe
    try {
      const subscriptions = await stripe.subscriptions.list({
        customer: tenant.stripe_customer_id,
        status: 'active',
        limit: 1
      });
      if (subscriptions.data.length > 0) {
        await stripe.subscriptions.cancel(subscriptions.data[0].id);
        console.log(`[Stripe] Suscripción ${subscriptions.data[0].id} cancelada automáticamente.`);
      }
    } catch (stripeErr: any) {
      console.warn('⚠️ No se pudo cancelar la suscripción en Stripe (puede que ya estuviera cancelada):', stripeErr.message);
    }

    // 4. Actualizar estado del inquilino en base de datos a cancelado/reembolsado
    const todayStr = new Date().toISOString().split('T')[0];
    await supabase
      .from('tenants')
      .update({
        subscription_status: 'cancelled',
        contract_end_date: todayStr
      })
      .eq('id', id);

    // 5. Registrar transacción negativa (gasto) en contabilidad
    const amountRefunded = refundableCharge.amount / 100;
    await supabase
      .from('accounting_transactions')
      .insert({
        type: 'expense',
        concept: `Reembolso Garantía 14 días: ${tenant.business_name} - Cargo ${refundableCharge.id}`,
        amount: amountRefunded,
        date: todayStr
      });

    res.json({
      success: true,
      message: `Reembolso de ${amountRefunded}€ procesado y suscripción cancelada.`,
      refund_id: refund.id
    });
  } catch (err: any) {
    console.error('Error al procesar reembolso:', err.message);
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
    whatsapp_immediate_notification_enabled,
    block_admin_access
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

    const existingBlockAdminAccess = existing ? await getBlockAdminAccess(existing.id) : false;
    const blockAdminAccessVal = block_admin_access !== undefined ? !!block_admin_access : existingBlockAdminAccess;

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
      twilio_whatsapp_number: twilio_whatsapp_number !== undefined ? twilio_whatsapp_number : (existing ? existing.twilio_whatsapp_number : null)
    };

    const hasImmediateCol = existing ? ('whatsapp_immediate_notification_enabled' in existing) : false;
    if (hasImmediateCol) {
      tenantData.whatsapp_immediate_notification_enabled = whatsapp_immediate_notification_enabled !== undefined ? !!whatsapp_immediate_notification_enabled : (existing ? existing.whatsapp_immediate_notification_enabled : true);
    }

    if (whatsapp_immediate_notification_enabled !== undefined) {
      let whObj: any = tenantData.working_hours || {};
      if (typeof whObj === 'string') {
        try { whObj = JSON.parse(whObj); } catch (e) { whObj = {}; }
      }
      whObj.whatsapp_immediate_notification_enabled = !!whatsapp_immediate_notification_enabled;
      tenantData.working_hours = whObj;
    } else if (existing) {
      const prevWorkingHours = typeof existing.working_hours === 'string' 
        ? JSON.parse(existing.working_hours) 
        : existing.working_hours;
      if (prevWorkingHours && prevWorkingHours.whatsapp_immediate_notification_enabled !== undefined) {
        let whObj: any = tenantData.working_hours || {};
        if (typeof whObj === 'string') {
          try { whObj = JSON.parse(whObj); } catch (e) { whObj = {}; }
        }
        whObj.whatsapp_immediate_notification_enabled = prevWorkingHours.whatsapp_immediate_notification_enabled;
        tenantData.working_hours = whObj;
      }
    }

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
      if (!attemptData.admin_pin) {
        attemptData.admin_pin = '0000';
      }
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
    if (tenant) {
      if (blockAdminAccessVal !== undefined) {
        await setBlockAdminAccess(tenant.id, blockAdminAccessVal);
        tenant.block_admin_access = blockAdminAccessVal;
      } else {
        tenant.block_admin_access = await getBlockAdminAccess(tenant.id);
      }
    }
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

// Helper para obtener el origen del cliente (evita redirigir a onrender.com)
function getRequestOrigin(req: any): string {
  // Priorizar x-forwarded-host si viene de un proxy como Vercel
  const forwardedHost = req.get('x-forwarded-host');
  if (forwardedHost) {
    const protocol = req.get('x-forwarded-proto') || 'https';
    return `${protocol}://${forwardedHost}`;
  }

  let origin = req.get('origin');
  if (!origin) {
    const referer = req.get('referer');
    if (referer) {
      try {
        const urlObj = new URL(referer);
        origin = urlObj.origin;
      } catch (e) {
        // ignore
      }
    }
  }
  if (!origin) {
    const host = req.get('host') || '';
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
    origin = `${protocol}://${host}`;
  }
  return origin;
}

// 1. Crear sesión de Stripe Checkout
app.post('/api/payments/create-checkout-session', async (req, res): Promise<void> => {
  const { tenant_id, plan_id } = req.body;
  if (!tenant_id || !plan_id) {
    res.status(400).json({ error: 'Faltan parámetros obligatorios (tenant_id, plan_id).' });
    return;
  }

  try {
    const origin = getRequestOrigin(req);
    const checkoutUrl = await createStripeCheckoutSession(tenant_id, plan_id, origin);
    res.json({ url: checkoutUrl });
  } catch (err: any) {
    console.error('Error al crear checkout session de Stripe:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 1b. Crear sesión de Stripe Checkout para compra de minutos adicionales
app.post('/api/payments/create-addon-checkout-session', async (req, res): Promise<void> => {
  const { tenant_id, pack } = req.body;
  if (!tenant_id || !pack) {
    res.status(400).json({ error: 'Faltan parámetros obligatorios (tenant_id, pack).' });
    return;
  }

  try {
    const origin = getRequestOrigin(req);
    const checkoutUrl = await createStripeAddonCheckoutSession(tenant_id, Number(pack), origin);
    res.json({ url: checkoutUrl });
  } catch (err: any) {
    console.error('Error al crear checkout session de Addon de minutos:', err.message);
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
    const origin = getRequestOrigin(req);
    const portalUrl = await createStripePortalSession(tenant_id, origin);
    res.json({ url: portalUrl });
  } catch (err: any) {
    console.error('Error al crear portal session de Stripe:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. Cancelar suscripción del cliente
app.post('/api/payments/cancel-subscription', async (req, res): Promise<void> => {
  const { tenant_id } = req.body;
  if (!tenant_id) {
    res.status(400).json({ error: 'Falta el parámetro obligatorio tenant_id.' });
    return;
  }

  try {
    // Obtener detalles del inquilino
    const { data: tenant, error: tErr } = await supabase.from('tenants').select('*').eq('id', tenant_id).single();
    if (tErr || !tenant) {
      res.status(404).json({ error: 'Cliente no encontrado.' });
      return;
    }

    // Si tiene suscripción activa en Stripe, intentar cancelarla en Stripe
    if (tenant.stripe_customer_id) {
      try {
        const stripe = await getStripeClient();
        const subscriptions = await stripe.subscriptions.list({
          customer: tenant.stripe_customer_id,
          status: 'active',
          limit: 1
        });
        
        if (subscriptions.data.length > 0) {
          await stripe.subscriptions.cancel(subscriptions.data[0].id);
          console.log(`[Stripe] Cancelada suscripción ${subscriptions.data[0].id} para el cliente ${tenant_id}`);
        }
      } catch (stripeErr: any) {
        console.warn('⚠️ No se pudo cancelar la suscripción en Stripe (puede que ya estuviera cancelada):', stripeErr.message);
      }
    }

    // Actualizar el inquilino en la base de datos a estado cancelado
    const todayStr = new Date().toISOString().split('T')[0];
    const { error: updErr } = await supabase
      .from('tenants')
      .update({
        subscription_status: 'cancelled',
        contract_end_date: todayStr
      })
      .eq('id', tenant_id);

    if (updErr) throw updErr;

    res.json({ status: 'success', message: 'Suscripción cancelada correctamente.' });
  } catch (err: any) {
    console.error('Error al cancelar la suscripción:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5. Obtener historial de facturas del cliente desde Stripe
app.get('/api/payments/invoices', async (req, res): Promise<void> => {
  const { tenant_id } = req.query;
  if (!tenant_id) {
    res.status(400).json({ error: 'Falta el parámetro obligatorio tenant_id.' });
    return;
  }

  try {
    const { data: tenant, error: tErr } = await supabase
      .from('tenants')
      .select('stripe_customer_id')
      .eq('id', tenant_id)
      .single();

    if (tErr || !tenant || !tenant.stripe_customer_id) {
      res.json({ invoices: [] });
      return;
    }

    const stripe = await getStripeClient();
    const invoiceList = await stripe.invoices.list({
      customer: tenant.stripe_customer_id,
      limit: 20
    });

    const formattedInvoices = invoiceList.data.map(inv => ({
      id: inv.id,
      number: inv.number || 'Borrador',
      amount: inv.amount_paid / 100,
      status: inv.status,
      pdf_url: inv.invoice_pdf || inv.hosted_invoice_url,
      hosted_url: inv.hosted_invoice_url,
      date: new Date(inv.created * 1000).toISOString().split('T')[0]
    }));

    res.json({ invoices: formattedInvoices });
  } catch (err: any) {
    console.error('Error al listar facturas de Stripe:', err.message);
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
        const type = session.metadata?.type;

        if (type === 'minutes_addon') {
          const minutes = Number(session.metadata?.minutes || 0);
          const amount = Number(session.metadata?.amount || 0);
          console.log(`🔔 Recibido pago de minutos extra para Tenant: ${tenantId}. Pack: +${minutes} min (Importe: ${amount}€)`);

          if (tenantId && minutes > 0) {
            try {
              // 1. Obtener inquilino
              const { data: tenant } = await supabase
                .from('tenants')
                .select('business_name, addon_minutes')
                .eq('id', tenantId)
                .single();

              const currentAddon = tenant?.addon_minutes || 0;
              const newAddon = currentAddon + minutes;

              // 2. Actualizar addon_minutes en tenants
              await supabase
                .from('tenants')
                .update({ addon_minutes: newAddon })
                .eq('id', tenantId);

              // 3. Registrar transacción contable
              await supabase
                .from('accounting_transactions')
                .insert({
                  type: 'income',
                  concept: `Compra Pack Minutos Extra: ${tenant?.business_name || tenantId} (+${minutes} min)`,
                  amount: amount,
                  date: new Date().toISOString().split('T')[0]
                });

              console.log(`✅ Adquirido pack de minutos con éxito para el inquilino ${tenantId}. Total acumulado: ${newAddon} min.`);
            } catch (err: any) {
              console.error('[Stripe Webhook Error] Error al procesar pack de minutos extra:', err.message);
            }
          }
        } else if (type === 'no_show_deposit') {
          const appointmentId = session.metadata?.appointment_id;
          console.log(`🔔 Recibido pago de fianza para la cita ${appointmentId} (Tenant: ${tenantId})...`);

          if (appointmentId && tenantId) {
            try {
              const { data: appointment, error: appErr } = await supabase
                .from('appointments')
                .select('*, tenants(*)')
                .eq('id', appointmentId)
                .single();

              if (appErr || !appointment) {
                console.error(`[Stripe Webhook Error] Cita ${appointmentId} no encontrada:`, appErr?.message);
              } else {
                const tenant = appointment.tenants;

                await supabase
                  .from('appointments')
                  .update({ status: 'confirmed' })
                  .eq('id', appointmentId);
                console.log(`Cita ${appointmentId} marcada como confirmed.`);

                const depositAmount = tenant.no_show_deposit_amount || 10.00;
                await supabase
                  .from('accounting_transactions')
                  .insert({
                    type: 'income',
                    concept: `Fianza Cita Online: ${appointment.patient_name}`,
                    amount: depositAmount,
                    date: new Date().toISOString().split('T')[0]
                  });

                if (appointment.google_event_id && tenant.google_refresh_token) {
                  const dateTimeStr = appointment.date_time;
                  const datePart = dateTimeStr.split('T')[0];
                  
                  const madridDate = new Date(dateTimeStr);
                  const madridTimeStr = madridDate.toLocaleTimeString('es-ES', {
                    timeZone: 'Europe/Madrid',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                  });

                  const isPeluqueria = tenant.business_sector === 'peluqueria' || 
                                       (tenant.business_name && (
                                         tenant.business_name.toLowerCase().includes('peluquería') || 
                                         tenant.business_name.toLowerCase().includes('peluqueria') || 
                                         tenant.business_name.toLowerCase().includes('barber')
                                       ));
                  const slotDurationMin = isPeluqueria ? 15 : 30;
                  
                  const calculateDurationHelper = (spec: string, tId: string) => {
                    if (tId !== '62d1ed82-287c-4329-941b-50b578c15b14') return 30;
                    const text = (spec || '').toLowerCase();
                    if ((text.includes('tres') || text.includes('3')) && text.includes('niño') && text.includes('caballero')) return 60;
                    if ((text.includes('dos') || text.includes('2')) && text.includes('niño') && text.includes('caballero')) return 45;
                    if ((text.includes('un') || text.includes('1')) && text.includes('niño') && text.includes('caballero')) return 30;
                    if (text.includes('corte') || text.includes('pelo') || text.includes('caballero') || text.includes('niño')) return 15;
                    return 15;
                  };
                  const durationMinutes = calculateDurationHelper(appointment.specialty, tenant.id);

                  await updateAppointment(
                    tenant.google_refresh_token,
                    appointment.google_event_id,
                    datePart,
                    madridTimeStr,
                    appointment.patient_name,
                    appointment.patient_email,
                    appointment.patient_phone,
                    appointment.specialty,
                    appointment.google_calendar_id || 'primary',
                    tenant.business_name,
                    tenant.business_sector,
                    durationMinutes
                  );
                  console.log(`✅ Evento de Google Calendar actualizado para cita ${appointmentId}`);
                }

                if (tenant.client_whatsapp_enabled !== false) {
                  const cleanPhone = appointment.patient_phone.split('|')[0].trim();
                  const formattedDate = new Date(appointment.date_time).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });
                  const formattedTime = new Date(appointment.date_time).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
                  const msg = `¡Fianza Recibida y Cita Confirmada! 📅✅\n\nHola ${appointment.patient_name}, hemos recibido correctamente su depósito de fianza. Su cita en ${tenant.business_name} ha quedado plenamente confirmada.\n\n🔹 Servicio: ${appointment.specialty}\n🔹 Fecha: ${formattedDate}\n🔹 Hora: ${formattedTime}\n\n¡Le esperamos!`;
                  sendWhatsAppMessage(cleanPhone, msg, tenant.id).catch(err => console.error('Error al enviar WhatsApp de fianza:', err));
                }
              }
            } catch (err: any) {
              console.error('[Stripe Webhook Error] Error procesando fianza:', err.message);
            }
          }
        } else if (tenantId && planId) {
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

            // AUTO-GENERACIÓN DE COMISIÓN DE COMERCIAL POR CONTRATACIÓN
            try {
              const { data: prospect } = await supabase
                .from('prospects')
                .select('*')
                .eq('demo_tenant_id', tenantId)
                .maybeSingle();
              
              if (prospect && prospect.commercial_agent_id) {
                if (prospect.classification !== 'contratado') {
                  await supabase
                    .from('prospects')
                    .update({ classification: 'contratado' })
                    .eq('id', prospect.id);
                    
                  await supabase
                    .from('lead_activity_log')
                    .insert({
                      prospect_id: prospect.id,
                      agent_id: prospect.commercial_agent_id,
                      action_type: 'status_change',
                      previous_status: prospect.classification || 'no_contactado',
                      new_status: 'contratado',
                      note: 'Suscripción activada automáticamente tras pago de Stripe Checkout.'
                    });
                }
                
                const { generateCommissionOnContratado } = require('./routes/comercial-panel');
                await generateCommissionOnContratado(prospect.id);
              }
            } catch (comErr: any) {
              console.error('[Stripe Webhook Error] Error al generar comisión automática:', comErr.message);
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

            // REGISTRO AUTOMÁTICO DE COMISIÓN RECURRENTE DE COMERCIAL
            try {
              const { data: prospect } = await supabase
                .from('prospects')
                .select('*')
                .eq('demo_tenant_id', tenant.id)
                .maybeSingle();

              if (prospect && prospect.commercial_agent_id && prospect.classification === 'contratado') {
                const { data: agent } = await supabase
                  .from('commercial_agents')
                  .select('*')
                  .eq('id', prospect.commercial_agent_id)
                  .maybeSingle();

                if (agent && agent.status === 'active' && agent.commission_type === 'percentage') {
                  const invoiceAmount = (invoice.amount_paid || 0) / 100;
                  if (invoiceAmount > 0) {
                    const currentPeriod = new Date().toISOString().substring(0, 7); // 'YYYY-MM'
                    
                    const { data: existing } = await supabase
                      .from('commissions')
                      .select('id')
                      .eq('agent_id', agent.id)
                      .eq('prospect_id', prospect.id)
                      .eq('period', currentPeriod)
                      .maybeSingle();
                    
                    if (!existing) {
                      const commissionAmount = invoiceAmount * (Number(agent.commission_value) / 100);
                      await supabase
                        .from('commissions')
                        .insert({
                          agent_id: agent.id,
                          prospect_id: prospect.id,
                          tenant_id: tenant.id,
                          type: 'percentage',
                          amount: commissionAmount,
                          paid: false,
                          period: currentPeriod
                        });
                      
                      console.log(`[Stripe Webhook] Generada comisión recurrente de ${commissionAmount}€ para ${agent.name} por factura pagada de ${tenant.business_name}`);
                    }
                  }
                }
              }
            } catch (recErr: any) {
              console.error('[Stripe Webhook Error] Error al generar comisión recurrente de comercial:', recErr.message);
            }

            // ==========================================
            // PROCESAMIENTO DEL SISTEMA DE REFERIDOS (COMISIONES Y DESCUENTOS)
            // ==========================================
            try {
              const invoiceAmount = (invoice.amount_paid || 0) / 100;
              const currentPeriod = new Date().toISOString().substring(0, 7); // 'YYYY-MM'

              // 1. Verificar si el pagador es un Nuevo Referido o Referido recurrente
              const { data: referral } = await supabase
                .from('referrals')
                .select('*')
                .eq('referred_email', tenant.email.trim().toLowerCase())
                .limit(1)
                .maybeSingle();

              if (referral) {
                let commissionAmount = 0;
                let shouldGenerateCommission = false;

                // Caso A: Primer pago del referido (Suscripción completada)
                if (referral.status === 'pending') {
                  console.log(`[Referidos] Convertido referido pendiente a activo: ${tenant.email}`);
                  
                  // Actualizar estado a subscribed
                  await supabase
                    .from('referrals')
                    .update({
                      status: 'subscribed',
                      referred_tenant_id: tenant.id
                    })
                    .eq('id', referral.id);

                  shouldGenerateCommission = true;
                  if (referral.commission_type === 'fixed') {
                    commissionAmount = Number(referral.commission_value);
                  } else {
                    commissionAmount = invoiceAmount * (Number(referral.commission_value) / 100);
                  }
                }
                // Caso B: Pagos recurrentes del referido (Modalidad porcentaje)
                else if (referral.status === 'subscribed' && referral.commission_type === 'percentage') {
                  // Validar que no se haya cobrado comisión ya en este período
                  const { data: existingComm } = await supabase
                    .from('referral_commissions')
                    .select('id')
                    .eq('referral_id', referral.id)
                    .eq('period', currentPeriod)
                    .maybeSingle();

                  if (!existingComm && invoiceAmount > 0) {
                    shouldGenerateCommission = true;
                    commissionAmount = invoiceAmount * (Number(referral.commission_value) / 100);
                  }
                }

                if (shouldGenerateCommission && commissionAmount > 0) {
                  // Guardar el devengo en referral_commissions
                  await supabase
                    .from('referral_commissions')
                    .insert({
                      referral_id: referral.id,
                      referrer_tenant_id: referral.referrer_tenant_id,
                      amount: commissionAmount,
                      period: referral.commission_type === 'percentage' ? currentPeriod : null,
                      status: 'pending'
                    });

                  console.log(`[Referidos] Generada comisión de referidos: ${commissionAmount}€ para referidor ${referral.referrer_tenant_id}`);

                  // Obtener datos del referidor
                  const { data: referrerTenant } = await supabase
                    .from('tenants')
                    .select('id, business_name, stripe_customer_id')
                    .eq('id', referral.referrer_tenant_id)
                    .single();

                  // Registrar la transacción contable (Gasto contable / Devengo de pasivo)
                  await supabase
                    .from('accounting_transactions')
                    .insert({
                      type: 'expense',
                      concept: `Devengo Comisión Referido: ${tenant.business_name} (Referidor: ${referrerTenant?.business_name || 'Desconocido'})`,
                      amount: commissionAmount,
                      date: todayStr
                    });

                  // Si el referidor tiene Stripe, abonar saldo a favor (Customer Balance) de inmediato
                  if (referrerTenant && referrerTenant.stripe_customer_id) {
                    try {
                      const stripe = await getStripeClient();
                      await stripe.customers.createBalanceTransaction(referrerTenant.stripe_customer_id, {
                        amount: -Math.round(commissionAmount * 100), // Negativo = Descuento/Saldo a favor
                        currency: 'eur',
                        description: `Comisión por Referido: ${tenant.business_name}`
                      });
                      console.log(`[Referidos] Abonado saldo a favor de ${commissionAmount}€ en Stripe para ${referrerTenant.business_name}`);
                    } catch (stripeErr: any) {
                      console.error('[Referidos Stripe Error] Error al abonar balance en Stripe:', stripeErr.message);
                    }
                  }
                }
              }

              // 2. Verificar si el pagador es un Referidor y consumió saldo de descuento
              if (invoice.starting_balance && invoice.starting_balance < 0) {
                const startingBal = Number(invoice.starting_balance);
                const endingBal = Number(invoice.ending_balance || 0);
                
                if (endingBal > startingBal) {
                  const appliedDiscount = (endingBal - startingBal) / 100;
                  console.log(`[Referidos] Detectado descuento por referidos aplicado en factura Stripe: ${appliedDiscount}€ para ${tenant.business_name}`);

                  // Obtener todas las comisiones pendientes del referidor ordenadas FIFO (más antiguas primero)
                  const { data: pendingCommissions } = await supabase
                    .from('referral_commissions')
                    .select('*')
                    .eq('referrer_tenant_id', tenant.id)
                    .eq('status', 'pending')
                    .order('created_at', { ascending: true });

                  if (pendingCommissions && pendingCommissions.length > 0) {
                    let remainingDiscount = appliedDiscount;
                    
                    for (const comm of pendingCommissions) {
                      if (remainingDiscount <= 0) break;
                      
                      const commAmount = Number(comm.amount);
                      if (commAmount <= remainingDiscount) {
                        await supabase
                          .from('referral_commissions')
                          .update({
                            status: 'applied',
                            applied_invoice_id: invoice.id || invoice.number
                          })
                          .eq('id', comm.id);

                        remainingDiscount -= commAmount;
                      } else {
                        await supabase
                          .from('referral_commissions')
                          .update({
                            status: 'applied',
                            applied_invoice_id: invoice.id || invoice.number
                          })
                          .eq('id', comm.id);

                        remainingDiscount = 0;
                      }
                    }
                  }

                  // Registrar el ajuste contable (Descuento contable aplicado)
                  await supabase
                    .from('accounting_transactions')
                    .insert({
                      type: 'expense',
                      concept: `Descuento por Referidos Aplicado: Factura ${invoice.number || ''} - Inquilino ${tenant.business_name}`,
                      amount: appliedDiscount,
                      date: todayStr
                    });
                }
              }

            } catch (referralErr: any) {
              console.error('[Stripe Webhook Error] Error al procesar lógica de referidos:', referralErr.message);
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
            
            // Reversión de comisiones y prospecto si ocurre cancelación en periodo de prueba (menos de 7 días)
            try {
              let isTrial = false;
              if (tenant.contract_start_date) {
                const contractStart = new Date(tenant.contract_start_date);
                const now = new Date();
                const diffTime = now.getTime() - contractStart.getTime();
                const diffDays = diffTime / (1000 * 60 * 60 * 24);
                isTrial = diffDays < 7;
              }

              if (isTrial) {
                console.log(`[Stripe Webhook] Detectada cancelación dentro del periodo de prueba de 7 días para ${tenant.business_name}. Limpiando comisiones e historial...`);
                
                // 1. Eliminar comisiones pendientes asociadas a este inquilino creadas hace menos de 7 días
                const { data: pendingComs } = await supabase
                  .from('commissions')
                  .select('*')
                  .eq('tenant_id', tenant.id)
                  .eq('paid', false);

                if (pendingComs && pendingComs.length > 0) {
                  const nowTime = new Date().getTime();
                  const comsToDelete = pendingComs
                    .filter((com: any) => {
                      const comCreated = new Date(com.created_at);
                      const diffDays = (nowTime - comCreated.getTime()) / (1000 * 60 * 60 * 24);
                      return diffDays < 7;
                    })
                    .map((com: any) => com.id);

                  if (comsToDelete.length > 0) {
                    const { error: delErr } = await supabase
                      .from('commissions')
                      .delete()
                      .in('id', comsToDelete);
                    if (delErr) {
                      console.error('[Stripe Webhook Error] Error al eliminar comisiones en prueba:', delErr.message);
                    } else {
                      console.log(`[Stripe Webhook] Eliminadas comisiones en periodo de prueba canceladas:`, comsToDelete);
                    }
                  }
                }

                // 2. Revertir prospecto a "descartado"
                const { data: prospect } = await supabase
                  .from('prospects')
                  .select('*')
                  .eq('demo_tenant_id', tenant.id)
                  .maybeSingle();

                if (prospect) {
                  await supabase
                    .from('prospects')
                    .update({ classification: 'descartado' })
                    .eq('id', prospect.id);

                  await supabase
                    .from('lead_activity_log')
                    .insert({
                      prospect_id: prospect.id,
                      agent_id: prospect.commercial_agent_id,
                      action_type: 'status_change',
                      previous_status: 'contratado',
                      new_status: 'descartado',
                      note: 'Suscripción cancelada en Stripe durante el periodo de prueba de 7 días. Se revierten comisiones y estado.'
                    });
                  console.log(`[Stripe Webhook] Revertido prospecto ${prospect.id} a descartado debido a cancelación temprana.`);
                }
              }
            } catch (trialErr: any) {
              console.error('[Stripe Webhook Error] Error al procesar reversión por periodo de prueba:', trialErr.message);
            }
            
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

const NEW_DEFAULT_PLANS = [
  {
    id: 'inicial_mensual',
    name: 'Plan Inicial Mensual',
    price: 79.00,
    cycle: 'monthly',
    features: [
      'Recepcionista de voz 24/7',
      'Google Calendar',
      'Voz estándar en español',
      'Confirmaciones por WhatsApp',
      'Garantía de reembolso de 14 días',
      'Cancela cuando quieras',
      'Descarga de facturas PDF',
      'Compra de minutos extra',
      'Pago seguro con Stripe'
    ],
    description: 'Para autónomos y profesionales que empiezan.'
  },
  {
    id: 'estandar_mensual',
    name: 'Plan Estándar Mensual',
    price: 149.00,
    cycle: 'monthly',
    features: [
      'Todo lo de Inicial',
      'Recordatorios automáticos por WhatsApp',
      'Modo vacaciones',
      'Sincronización con software médico (Gesden, Dentrix)',
      'Multi-profesional',
      'Fianza anti no-show',
      'Garantía de reembolso de 14 días',
      'Cancela cuando quieras',
      'Descarga de facturas PDF',
      'Compra de minutos extra',
      'Pago seguro con Stripe'
    ],
    description: 'Para clínicas y negocios en pleno crecimiento.'
  },
  {
    id: 'premium_mensual',
    name: 'Plan Premium Mensual',
    price: 249.00,
    cycle: 'monthly',
    features: [
      'Todo lo de Estándar',
      'Voz clonada (instant voice cloning)',
      'Campañas outbound automatizadas',
      'Análisis conversacional avanzado',
      'Múltiples números',
      'Garantía de reembolso de 14 días',
      'Cancela cuando quieras',
      'Descarga de facturas PDF',
      'Compra de minutos extra',
      'Pago seguro con Stripe'
    ],
    description: 'Para empresas con varios centros o alto volumen.'
  },
  {
    id: 'inicial_anual',
    name: 'Plan Inicial Anual',
    price: 900.00,
    cycle: 'annually',
    features: [
      'Recepcionista de voz 24/7',
      'Google Calendar',
      'Voz estándar en español',
      'Confirmaciones por WhatsApp',
      'Garantía de reembolso de 14 días (ahorro de 48€/año)',
      'Cancela cuando quieras',
      'Descarga de facturas PDF',
      'Compra de minutos extra',
      'Pago seguro con Stripe'
    ],
    description: 'Ahorras 48€/año'
  },
  {
    id: 'estandar_anual',
    name: 'Plan Estándar Anual',
    price: 1668.00,
    cycle: 'annually',
    features: [
      'Todo lo de Inicial',
      'Recordatorios automáticos por WhatsApp',
      'Modo vacaciones',
      'Sincronización con software médico (Gesden, Dentrix)',
      'Multi-profesional',
      'Fianza anti no-show',
      'Garantía de reembolso de 14 días (ahorro de 120€/año)',
      'Cancela cuando quieras',
      'Descarga de facturas PDF',
      'Compra de minutos extra',
      'Pago seguro con Stripe'
    ],
    description: 'Ahorras 120€/año'
  },
  {
    id: 'premium_anual',
    name: 'Plan Premium Anual',
    price: 2748.00,
    cycle: 'annually',
    features: [
      'Todo lo de Estándar',
      'Voz clonada (instant voice cloning)',
      'Campañas outbound automatizadas',
      'Análisis conversacional avanzado',
      'Múltiples números',
      'Garantía de reembolso de 14 días (ahorro de 240€/año)',
      'Cancela cuando quieras',
      'Descarga de facturas PDF',
      'Compra de minutos extra',
      'Pago seguro con Stripe'
    ],
    description: 'Ahorras 240€/año'
  }
];

// Ruta pública para listar planes en la landing page
app.get('/api/plans', async (req, res): Promise<void> => {
  try {
    const { data: plans, error } = await supabase.from('plans').select('*').order('price', { ascending: true });
    if (error) {
      if (error.code === '42P01') {
        res.json({ plans: NEW_DEFAULT_PLANS });
        return;
      }
      throw error;
    }
    res.json({ plans });
  } catch (err: any) {
    console.error('Error al listar planes públicos:', err);
    res.status(500).json({ error: err.message });
  }
});

// 1. Gestión de Planes de Precios
app.get('/api/admin/plans', async (req, res): Promise<void> => {
  try {
    const { data: plans, error } = await supabase.from('plans').select('*').order('price', { ascending: true });
    if (error) {
      if (error.code === '42P01') {
        res.json({ plans: NEW_DEFAULT_PLANS, migration_required: true });
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

// Endpoint de Estadísticas Agregadas para el Dashboard de Administración
app.get('/api/admin/dashboard-stats', async (req, res): Promise<void> => {
  try {
    // 1. Obtener total de llamadas e intenciones de la tabla call_logs
    const { data: calls, error: callsErr } = await supabase
      .from('call_logs')
      .select('intent_tag, call_duration');
    
    if (callsErr && callsErr.code !== '42P01') throw callsErr;

    const totalCalls = calls ? calls.length : 0;
    let totalSeconds = 0;
    const intentCounts: { [key: string]: number } = {};

    (calls || []).forEach(c => {
      totalSeconds += (c.call_duration || 0);
      let tag = c.intent_tag || 'Consulta General';
      if (tag.endsWith('_hidden')) tag = tag.replace('_hidden', '');
      intentCounts[tag] = (intentCounts[tag] || 0) + 1;
    });

    const totalMinutes = Math.round(totalSeconds / 60);

    // 2. Obtener estadísticas de prospectos (leads)
    const { data: prospects, error: prospectsErr } = await supabase
      .from('prospects')
      .select('classification');

    if (prospectsErr && prospectsErr.code !== '42P01') throw prospectsErr;

    const totalLeads = prospects ? prospects.length : 0;
    const leadsByStatus: { [key: string]: number } = {};
    (prospects || []).forEach(p => {
      const status = p.classification || 'sin_clasificar';
      leadsByStatus[status] = (leadsByStatus[status] || 0) + 1;
    });

    // 3. Obtener comerciales activos
    const { data: comerciales, error: comErr } = await supabase
      .from('comerciales')
      .select('id');

    if (comErr && comErr.code !== '42P01') throw comErr;
    const totalComerciales = comerciales ? comerciales.length : 0;

    res.json({
      calls: {
        total: totalCalls,
        minutes: totalMinutes,
        intents: intentCounts
      },
      prospects: {
        total: totalLeads,
        byStatus: leadsByStatus
      },
      comerciales: {
        total: totalComerciales
      }
    });
  } catch (err: any) {
    console.error('Error al generar estadísticas de dashboard:', err);
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
                text: `Eres un redactor legal experto. Genera un contrato de prestación de servicios para el SaaS Corandar en base a la siguiente solicitud de indicaciones. Genera únicamente el contrato formal bien redactado en español, sin preámbulos, comentarios, ni etiquetas markdown adicionales. Asegúrate de incluir una cláusula explícita sobre el "Cobro por Uso Adicional" en la que se detalle que, para los planes que no tengan minutos ilimitados (como el Plan Estándar), cualquier consumo de minutos que exceda el límite del plan se facturará a razón de 0.35€ por minuto adicional. Indicaciones: ${prompt}`
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

    // Map logs to identify hidden ones and clean up their intent_tag
    const mappedLogs = (logs || []).map(log => {
      const isHidden = log.intent_tag && log.intent_tag.endsWith('_hidden');
      return {
        ...log,
        intent_tag: isHidden ? log.intent_tag.replace('_hidden', '') : log.intent_tag,
        hidden: !!isHidden
      };
    });

    res.json({ logs: mappedLogs, migration_required: false });
  } catch (err: any) {
    console.error('Error al obtener call logs:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5B. Eliminar un registro de llamada individual
app.delete('/api/tenants/:tenant_id/call-logs/:log_id', async (req, res): Promise<void> => {
  const { tenant_id, log_id } = req.params;
  try {
    // Obtener el log actual para saber su intent_tag
    const { data: log, error: fetchErr } = await supabase
      .from('call_logs')
      .select('intent_tag')
      .eq('id', log_id)
      .eq('tenant_id', tenant_id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;

    if (log) {
      const newTag = (log.intent_tag || 'Consulta General') + '_hidden';
      const { error } = await supabase
        .from('call_logs')
        .update({ intent_tag: newTag })
        .eq('id', log_id)
        .eq('tenant_id', tenant_id);

      if (error) throw error;
    }
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
    // 1. Obtener todos los logs del tenant
    const { data: logs, error: fetchErr } = await supabase
      .from('call_logs')
      .select('id, intent_tag')
      .eq('tenant_id', tenant_id);

    if (fetchErr) throw fetchErr;

    // Filtrar los que no están ocultos ya
    const activeLogs = (logs || []).filter(log => !log.intent_tag || !log.intent_tag.endsWith('_hidden'));

    // 2. Actualizar cada uno de ellos para añadirle '_hidden'
    for (const log of activeLogs) {
      const newTag = (log.intent_tag || 'Consulta General') + '_hidden';
      await supabase
        .from('call_logs')
        .update({ intent_tag: newTag })
        .eq('id', log.id);
    }

    res.json({ status: 'success', message: 'Historial de llamadas limpiado.' });
  } catch (err: any) {
    console.error('Error al limpiar call logs:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5D. Desconectar Google Calendar de un inquilino
app.post('/api/tenants/:tenant_id/disconnect-calendar', async (req, res): Promise<void> => {
  const { tenant_id } = req.params;
  try {
    const { error } = await supabase
      .from('tenants')
      .update({ google_refresh_token: null })
      .eq('id', tenant_id);

    if (error) throw error;

    res.json({ status: 'success', message: 'Google Calendar desconectado exitosamente.' });
  } catch (err: any) {
    console.error('Error al desconectar Google Calendar:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5E. Subir y procesar PDF de Base de Conocimientos
app.post('/api/upload-pdf', async (req, res): Promise<void> => {
  const { filename, base64 } = req.body;
  if (!base64) {
    res.status(400).json({ error: 'No se ha proporcionado el archivo base64.' });
    return;
  }

  try {
    const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
    const buffer = Buffer.from(base64Data, 'base64');

    // Extraer texto del PDF usando la clase PDFParse de mehmet-kozan/pdf-parse
    const parser = new pdf.PDFParse({ data: new Uint8Array(buffer) });
    const textResult = await parser.getText();
    const pdfText = textResult.text;
    await parser.destroy();
    
    // Carpeta destino para guardar el PDF
    const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const uniqueFilename = `${Date.now()}_${filename.replace(/\s+/g, '_')}`;
    const filePath = path.join(uploadsDir, uniqueFilename);
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/${uniqueFilename}`;

    res.json({
      status: 'success',
      text: pdfText,
      url: publicUrl
    });
  } catch (err: any) {
    console.error('Error al procesar el PDF:', err);
    res.status(500).json({ error: 'No se pudo procesar el archivo PDF. Asegúrate de que no esté protegido o dañado.' });
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

// POST: Clonar voz expresiva (Click & Clone) mediante ElevenLabs
app.post('/api/voice/clone', async (req, res): Promise<void> => {
  const { tenant_id, audio_base64, voice_name } = req.body;
  if (!tenant_id || !audio_base64) {
    res.status(400).json({ error: 'Faltan parámetros obligatorios (tenant_id, audio_base64).' });
    return;
  }

  try {
    const elevenLabsApiKey = await getSettingVal('ELEVENLABS_API_KEY') || process.env.ELEVENLABS_API_KEY;
    if (!elevenLabsApiKey) {
      res.status(500).json({ error: 'No se ha configurado la API Key de ElevenLabs en los ajustes.' });
      return;
    }

    // Limpiar cabeceras de Data URL si existen en el base64
    const base64Data = audio_base64.replace(/^data:audio\/\w+;base64,/, '');
    const audioBuffer = Buffer.from(base64Data, 'base64');
    
    // Crear el FormData usando el constructor nativo de Node.js v24
    const formData = new FormData();
    formData.append('name', voice_name || `Receptia Clone - ${tenant_id}`);
    
    // Crear el Blob para el archivo
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });
    formData.append('files', blob, 'sample.wav');
    formData.append('description', `Clonado de voz express de Receptia para tenant ${tenant_id}`);

    console.log(`[Voice Clone] Enviando audio a ElevenLabs para clonación (${audioBuffer.length} bytes)...`);
    const response = await axios.post('https://api.elevenlabs.io/v1/voices/add', formData, {
      headers: {
        'xi-api-key': elevenLabsApiKey,
      }
    });

    const voiceId = response.data.voice_id;
    if (!voiceId) {
      throw new Error('ElevenLabs no devolvió un voice_id válido.');
    }

    const formattedVoiceId = `elevenlabs_${voiceId}`;
    console.log(`[Voice Clone] Clonación exitosa. Voice ID: ${voiceId}. Actualizando tenant ${tenant_id}...`);

    // Guardar en la base de datos de Supabase
    const { data: updatedTenant, error: dbErr } = await supabase
      .from('tenants')
      .update({ voice_id: formattedVoiceId })
      .eq('id', tenant_id)
      .select()
      .single();

    if (dbErr) {
      throw dbErr;
    }

    // Sincronizar en segundo plano con Retell AI
    let webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
    if (!webhookBaseUrl) {
      const host = req.get('host') || '';
      const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
      webhookBaseUrl = `${protocol}://${host}`;
    }

    console.log(`[Voice Clone] Sincronizando con Retell AI usando webhookBaseUrl: ${webhookBaseUrl}...`);
    await syncTenantWithRetell(updatedTenant, webhookBaseUrl);

    res.json({ success: true, voice_id: formattedVoiceId });
  } catch (err: any) {
    const errorDetails = err.response?.data || err.message;
    console.error('[Voice Clone Error]:', errorDetails);
    res.status(500).json({ error: typeof errorDetails === 'object' ? JSON.stringify(errorDetails) : errorDetails });
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

    console.log('[Catalog API] Listando agentes de Retell AI (V2)...');
    const response = await axios.post('https://api.retellai.com/v2/list-agents', {
      filter_criteria: {
        channel: { op: 'eq', value: 'voice', type: 'string' }
      }
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    res.json(response.data?.items || []);
  } catch (err: any) {
    console.error('Error al listar agentes de Retell:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// POST: Responder mensajes del widget de chat público
app.post('/api/chat/widget', async (req, res): Promise<void> => {
  const { tenant_id, message, session_id } = req.body;
  if (!tenant_id || !message || !session_id) {
    res.status(400).json({ error: 'Faltan parámetros obligatorios (tenant_id, message, session_id).' });
    return;
  }

  try {
    const host = req.get('host') || '';
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
    const webhookBaseUrl = `${protocol}://${host}`;

    const reply = await processChatbotMessage(tenant_id, session_id, message.trim(), webhookBaseUrl);
    res.json({ response: reply });
  } catch (err: any) {
    console.error('[Widget Chat API ERROR]:', err.message);
    res.status(500).json({ error: err.message || 'Error al procesar el mensaje del chatbot.' });
  }
});

// GET: Obtener detalles públicos de un inquilino (para el widget de chat)
app.get('/api/prospecting/get-tenant-public', async (req, res): Promise<void> => {
  const { id } = req.query;
  if (!id) {
    res.status(400).json({ error: 'Falta el parámetro id.' });
    return;
  }

  try {
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select('business_name, voice_id, chatbot_welcome_message')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    res.json(tenant || {});
  } catch (err: any) {
    console.error('Error al obtener tenant público:', err.message);
    res.status(500).json({ error: err.message });
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
  const passwordsToTry = [
    '5MP)3i9P7wjBr[',
    process.env.SUPABASE_DB_PASSWORD,
    '1S67.!3CFitNmj'
  ].filter(Boolean) as string[];

  let migrationSuccess = false;
  let lastErrorMsg = '';

  for (const password of passwordsToTry) {
    // Opción 1: Conexión Directa (Puerto 5432) - Evita el circuit breaker de PgBouncer
    try {
      console.log(`[Migration Endpoint] Intentando conexión DIRECTA (puerto 5432) con contraseña ${password.substring(0, 3)}...`);
      const client = new Client({
        host: `db.${projectRef}.supabase.co`,
        port: 5432,
        database: 'postgres',
        user: 'postgres',
        password,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 4000
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
        ADD COLUMN IF NOT EXISTS whatsapp_immediate_notification_enabled BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS block_admin_access BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS personality_tone INT DEFAULT 3,
        ADD COLUMN IF NOT EXISTS personality_focus INT DEFAULT 3,
        ADD COLUMN IF NOT EXISTS personality_speed NUMERIC DEFAULT 1.0,
        ADD COLUMN IF NOT EXISTS text_back_enabled BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS text_back_message TEXT DEFAULT 'Hola! Vimos que nos llamaste pero no pudimos responder. ¿Te gustaría agendar una cita de forma rápida por este chat?';
        
        ALTER TABLE call_logs 
        ADD COLUMN IF NOT EXISTS retell_call_id TEXT;
        
        NOTIFY pgrst, 'reload schema';
      `);
      console.log('[Migration Endpoint] ✅ Columnas añadidas con éxito (Conexión Directa).');
      await client.end();
      migrationSuccess = true;
      res.json({ success: true, message: 'Migración ejecutada con éxito mediante conexión DIRECTA.' });
      return;
    } catch (directErr: any) {
      console.warn('[Migration Endpoint] Falló la conexión directa:', directErr.message);
      lastErrorMsg = `Direct: ${directErr.message}`;
    }

    // Opción 2: Conexión Pooler (Puerto 6543) - Fallback
    try {
      console.log(`[Migration Endpoint] Intentando conexión vía POOLER (puerto 6543) con contraseña ${password.substring(0, 3)}...`);
      const client = new Client({
        host: 'aws-0-eu-west-1.pooler.supabase.com',
        port: 6543,
        database: 'postgres',
        user: `postgres.${projectRef}`,
        password,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 4000
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
        ADD COLUMN IF NOT EXISTS whatsapp_immediate_notification_enabled BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS block_admin_access BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS personality_tone INT DEFAULT 3,
        ADD COLUMN IF NOT EXISTS personality_focus INT DEFAULT 3,
        ADD COLUMN IF NOT EXISTS personality_speed NUMERIC DEFAULT 1.0,
        ADD COLUMN IF NOT EXISTS text_back_enabled BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS text_back_message TEXT DEFAULT 'Hola! Vimos que nos llamaste pero no pudimos responder. ¿Te gustaría agendar una cita de forma rápida por este chat?';
        
        ALTER TABLE call_logs 
        ADD COLUMN IF NOT EXISTS retell_call_id TEXT;
        
        NOTIFY pgrst, 'reload schema';
      `);
      console.log('[Migration Endpoint] ✅ Columnas añadidas con éxito (Conexión Pooler).');
      await client.end();
      migrationSuccess = true;
      res.json({ success: true, message: 'Migración ejecutada con éxito mediante conexión POOLER.' });
      return;
    } catch (poolErr: any) {
      console.error('[Migration Endpoint ERROR] Falló la conexión por pooler:', poolErr.message);
      lastErrorMsg = `Pooler: ${poolErr.message}`;
    }
  }

  res.status(500).json({ error: `La migración falló tras intentar todas las contraseñas. Último error: ${lastErrorMsg}` });
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
    clearSettingsCache();
    res.json({ status: 'success', message: 'Ajustes guardados correctamente.' });
  } catch (err: any) {
    console.error('Error al guardar ajustes:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para sincronizar masivamente todos los agentes con Retell AI
app.post('/api/admin/settings/sync-all-agents', async (req, res): Promise<void> => {
  try {
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('*')
      .is('is_archived', false);
    
    if (error) throw error;
    
    const activeTenants = (tenants || []).filter(t => t.retell_agent_id && t.retell_agent_id.trim() !== '');
    
    if (activeTenants.length === 0) {
      res.json({ success: true, count: 0, message: 'No hay inquilinos activos con agentes configurados.' });
      return;
    }
    
    const webhookBaseUrl = `${req.protocol}://${req.get('host')}`;
    let successCount = 0;
    
    for (const tenant of activeTenants) {
      try {
        let workingHoursObj = tenant.working_hours;
        if (typeof workingHoursObj === 'string') {
          try { workingHoursObj = JSON.parse(workingHoursObj); } catch (e) {}
        }
        tenant.client_enable_multi_professional = workingHoursObj?.client_enable_multi_professional !== false;
        tenant.client_enable_no_show_deposits = workingHoursObj?.client_enable_no_show_deposits !== false;
        tenant.whatsapp_immediate_notification_enabled = tenant.whatsapp_immediate_notification_enabled !== undefined && tenant.whatsapp_immediate_notification_enabled !== null
          ? tenant.whatsapp_immediate_notification_enabled
          : (workingHoursObj?.whatsapp_immediate_notification_enabled !== false);
        
        await syncTenantWithRetell(tenant, webhookBaseUrl);
        successCount++;
      } catch (syncErr: any) {
        console.error(`Error al sincronizar agente para inquilino ${tenant.email}:`, syncErr.message);
      }
    }
    
    res.json({ success: true, count: successCount, total: activeTenants.length, message: `Sincronizados ${successCount} de ${activeTenants.length} agentes correctamente.` });
  } catch (err: any) {
    console.error('Error al sincronizar todos los agentes:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint público para obtener la frecuencia de refresco configurada
app.get('/api/public/refresh-interval', async (req, res): Promise<void> => {
  try {
    const interval = await getSettingVal('refresh_interval');
    res.json({ refresh_interval: interval || '30' });
  } catch (err: any) {
    console.error('Error al obtener refresh-interval público:', err);
    res.json({ refresh_interval: '30' });
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
    let tenant: any = null;
    
    // Intentar consultar incluyendo la columna demo_calls_count
    const firstQuery = await supabase
      .from('tenants')
      .select('retell_agent_id, subscription_status, demo_calls_count')
      .eq('id', tenant_id)
      .single();
      
    if (firstQuery.error && (firstQuery.error.message?.includes('demo_calls_count') || firstQuery.error.code === 'PGRST204')) {
      console.warn('[Client Test Call] La columna demo_calls_count no existe en la base de datos. Saltando validación de límite.');
      const fallbackQuery = await supabase
        .from('tenants')
        .select('retell_agent_id, subscription_status')
        .eq('id', tenant_id)
        .single();
      if (fallbackQuery.error || !fallbackQuery.data) {
        res.status(404).json({ error: 'No se encontró un Agente de Voz configurado para este negocio.' });
        return;
      }
      tenant = fallbackQuery.data;
    } else {
      if (firstQuery.error || !firstQuery.data) {
        res.status(404).json({ error: 'No se encontró un Agente de Voz configurado para este negocio.' });
        return;
      }
      tenant = firstQuery.data;
    }

    if (!tenant.retell_agent_id) {
      res.status(404).json({ error: 'No se encontró un Agente de Voz configurado para este negocio.' });
      return;
    }

    const isTrial = tenant.subscription_status === 'trial';
    let nextCount = tenant.demo_calls_count || 0;

    if (isTrial && tenant.demo_calls_count !== undefined) {
      if (tenant.demo_calls_count >= 5) {
        res.status(403).json({ error: 'Has alcanzado el límite de 5 llamadas de prueba en tu demostración. Para continuar, por favor contrata un plan de pago o contacta con el soporte para ampliar tus pruebas.' });
        return;
      }
      nextCount = (tenant.demo_calls_count || 0) + 1;
      const { error: updErr } = await supabase
        .from('tenants')
        .update({ demo_calls_count: nextCount })
        .eq('id', tenant_id);
      if (updErr) {
        console.warn(`[Client Test Call WARNING] No se pudo incrementar demo_calls_count para ${tenant_id}:`, updErr.message);
      }
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
      call_id: response.data.call_id,
      demo_calls_count: isTrial && tenant.demo_calls_count !== undefined ? nextCount : undefined
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

// Endpoint público para trackeo de apertura de correos (Outreach)
app.get('/api/outreach/track-open', async (req, res): Promise<void> => {
  const { prospect_id } = req.query;

  if (prospect_id && typeof prospect_id === 'string') {
    try {
      console.log(`[Outreach Track] Apertura de correo detectada para prospecto: ${prospect_id}`);
      
      // Obtener el valor actual de opened_count para incrementarlo
      const { data: currentVal } = await supabase
        .from('prospects')
        .select('opened_count')
        .eq('id', prospect_id)
        .maybeSingle();

      const newCount = ((currentVal?.opened_count || 0) as number) + 1;

      // Actualizar registro en base de datos
      await supabase
        .from('prospects')
        .update({
          opened_at: new Date().toISOString(),
          opened_count: newCount
        })
        .eq('id', prospect_id);

    } catch (err: any) {
      console.error(`[Outreach Track Error] No se pudo guardar la apertura para ${prospect_id}:`, err.message);
    }
  }

  // Responder siempre con una imagen transparente de 1x1 píxel en formato GIF
  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private'
  });
  res.end(pixel);
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
    // Check if client is allowed to change PIN (must have active subscription or signed contract)
    const { data: tenant, error: fetchErr } = await supabase
      .from('tenants')
      .select('subscription_status, signed_contract_content, stripe_subscription_id')
      .eq('id', id)
      .single();

    if (fetchErr || !tenant) {
      res.status(404).json({ error: 'Inquilino no encontrado.' });
      return;
    }

    const hasContractOrSub = 
      (tenant.signed_contract_content && tenant.signed_contract_content.trim() !== '') || 
      (tenant.stripe_subscription_id && tenant.stripe_subscription_id.trim() !== '') ||
      (tenant.subscription_status && tenant.subscription_status !== 'trial');

    if (!hasContractOrSub) {
      res.status(403).json({ error: 'La posibilidad de cambiar el PIN requiere una suscripción activa o un contrato firmado. Mientras tanto, tu PIN predeterminado es 0000.' });
      return;
    }

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

// Endpoint público para capturar contactos desde la Landing Page
app.post('/api/lead', async (req, res): Promise<void> => {
  const { name, company, email, phone, sector, message } = req.body;

  if (!company || !name || !email || !sector) {
    res.status(400).json({ error: 'Faltan campos obligatorios para el registro del lead.' });
    return;
  }

  try {
    // 1. Guardar el prospecto en la base de datos de Supabase usando columnas existentes
    const { error: dbError } = await supabase
      .from('prospects')
      .insert({
        business_name: `${company} (Contacto: ${name})`,
        email: email,
        phone: phone || null,
        sector: sector,
        commercial_notes: `Nombre del Contacto: ${name}\nMensaje: ${message || 'Sin mensaje adicional.'}`,
        classification: 'no_contactado',
        status: 'extracted'
      });

    if (dbError) {
      console.error('[Landing Contact API] Error al guardar lead en Supabase:', dbError.message);
    } else {
      console.log(`[Landing Contact API] Lead de contacto guardado en Supabase: ${company} (${name})`);
    }

    // 2. Intentar enviar notificación de correo a receptia@corandar.com
    const resendApiKey = await getSettingVal('RESEND_API_KEY') || process.env.RESEND_API_KEY;
    const resendFrom = await getSettingVal('RESEND_FROM_EMAIL') || process.env.RESEND_FROM_EMAIL || 'Receptia Demos <onboarding@resend.dev>';
    const receiverEmail = process.env.CONTACT_RECEIVER_EMAIL || 'receptia@corandar.com';

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
        <h2 style="color: #8b5cf6; margin-top: 0;">Nuevo Lead desde la Landing Page</h2>
        <hr style="border: 0; border-top: 1px solid #eee; margin-bottom: 20px;">
        <p><strong>Nombre del Contacto:</strong> ${name}</p>
        <p><strong>Negocio / Empresa:</strong> ${company}</p>
        <p><strong>Email Profesional:</strong> <a href="mailto:${email}">${email}</a></p>
        <p><strong>Teléfono:</strong> ${phone || 'No provisto'}</p>
        <p><strong>Sector:</strong> ${sector}</p>
        <p><strong>Mensaje / Caso:</strong></p>
        <blockquote style="background: #f9f9f9; border-left: 5px solid #8b5cf6; padding: 12px 18px; margin: 15px 0; font-style: italic; color: #444;">
          ${message ? message.replace(/\n/g, '<br>') : 'Sin mensaje adicional.'}
        </blockquote>
        <hr style="border: 0; border-top: 1px solid #eee; margin-top: 25px; margin-bottom: 15px;">
        <p style="font-size: 0.8rem; color: #888; text-align: center;">Este es un mensaje automático del servidor de Receptia SaaS.</p>
      </div>
    `;

    if (resendApiKey && resendApiKey !== 'YOUR_RESEND_API_KEY') {
      console.log('[Landing Contact API] Utilizando la API HTTP de Resend para enviar notificación...');
      axios.post('https://api.resend.com/emails', {
        from: resendFrom,
        to: receiverEmail,
        subject: `Nuevo Lead de Contacto: ${company}`,
        html: htmlContent
      }, {
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        }
      })
      .then(resendRes => {
        console.log(`[Landing Contact API] ✅ Notificación enviada con éxito vía Resend HTTP API. ID: ${resendRes.data?.id}`);
      })
      .catch(resendErr => {
        console.error('[Landing Contact API] ❌ Error al enviar vía Resend HTTP API:', resendErr.response?.data || resendErr.message);
      });
    } else {
      console.log('[Landing Contact API] Resend no configurado en los Ajustes. Intentando SMTP fallback...');
      let transporter = null;
      let mailFrom = '';

      if (process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS) {
        // Configuración SMTP Modular (e.g. Webempresa, etc.) con timeouts de 5s para evitar cuelgues
        transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT),
          secure: process.env.SMTP_SECURE === 'true',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          },
          connectionTimeout: 5000,
          greetingTimeout: 5000,
          socketTimeout: 5000
        });
        mailFrom = process.env.SMTP_USER;
        console.log(`[Landing Contact API] Utilizando transporte SMTP modular (${process.env.SMTP_HOST})`);
      } else if (process.env.GOOGLE_EMAIL && process.env.GOOGLE_PASSWORD) {
        // Fallback a Gmail con timeouts de 5s
        transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: process.env.GOOGLE_EMAIL,
            pass: process.env.GOOGLE_PASSWORD
          },
          connectionTimeout: 5000,
          greetingTimeout: 5000,
          socketTimeout: 5000
        });
        mailFrom = process.env.GOOGLE_EMAIL;
        console.log('[Landing Contact API] Utilizando transporte Gmail (Fallback)');
      }

      if (transporter && mailFrom) {
        const mailOptions = {
          from: `"Receptia Landing Page" <${mailFrom}>`,
          to: receiverEmail,
          subject: `Nuevo Lead de Contacto: ${company}`,
          html: htmlContent
        };

        // Enviar el correo en segundo plano (asíncronamente) para no bloquear al usuario en la landing
        transporter.sendMail(mailOptions)
          .then(() => {
            console.log(`[Landing Contact API] Notificación de email enviada con éxito a ${receiverEmail}`);
          })
          .catch((mailErr: any) => {
            console.error('[Landing Contact API] Error al enviar email de contacto:', mailErr.message);
          });
      } else {
        console.warn('[Landing Contact API] Ningún transporte de correo configurado. Omisión de envío de correo.');
      }
    }
 
    res.json({ success: true, message: 'Lead capturado y notificado con éxito.' });
  } catch (err: any) {
    console.error('[Landing Contact API] Excepción no controlada:', err.message);
    res.status(500).json({ error: 'Error interno del servidor al procesar el contacto.' });
  }
});

// Registrar rutas de webhook
app.use('/api/webhook', webhookRouter);
app.use('/api/admin/prospects', prospectingRouter);
app.use('/api/integrations/pms', pmsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/admin/comerciales', comercialesRouter);
app.use('/api/comercial', comercialPanelRouter);
app.use('/api/optimization', optimizationRouter);
app.use('/api/referrals', referralsRouter);



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
            const dateStr = dateObj.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric' });
            const timeStr = dateObj.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
            
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

// Migraciones de Base de Datos para Prospección B2B
async function runDatabaseMigrations() {
  const { Client } = require('pg');
  const projectRef = 'vnlbxfhzfuamzyqylkvd';
  const passwordsToTry = [
    '5MP)3i9P7wjBr[',
    process.env.SUPABASE_DB_PASSWORD,
    '1S67.!3CFitNmj'
  ].filter(Boolean) as string[];

  const query = async (clientInstance: any) => {
    // 1. Crear ENUM de estados de prospección si no existe
    await clientInstance.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'prospect_status') THEN
          CREATE TYPE prospect_status AS ENUM ('extracted', 'demo_created', 'audio_generated', 'email_sent', 'failed');
        END IF;
      END
      $$;
    `);

    // 2. Crear tabla prospects
    await clientInstance.query(`
      CREATE TABLE IF NOT EXISTS prospects (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        business_name VARCHAR NOT NULL,
        email VARCHAR,
        phone VARCHAR,
        website VARCHAR,
        address TEXT,
        sector VARCHAR,
        specialties TEXT[],
        demo_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
        demo_url VARCHAR,
        audio_url VARCHAR,
        status prospect_status DEFAULT 'extracted',
        error_details TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
      );
    `);

    // Asegurar columna classification en prospects si no existe
    await clientInstance.query(`
      ALTER TABLE prospects 
      ADD COLUMN IF NOT EXISTS classification VARCHAR DEFAULT 'no_contactado';
    `);

    // Asegurar columnas de tracking de apertura en prospects si no existen
    await clientInstance.query(`
      ALTER TABLE prospects 
      ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS opened_count INT DEFAULT 0;
    `);

    // Asegurar columnas para contacto de landing en prospects si no existen
    await clientInstance.query(`
      ALTER TABLE prospects 
      ADD COLUMN IF NOT EXISTS notes TEXT,
      ADD COLUMN IF NOT EXISTS contact_name VARCHAR;
    `);

    // Asegurar columna block_admin_access en tenants si no existe
    await clientInstance.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS block_admin_access BOOLEAN DEFAULT FALSE;
    `);

    // Asegurar columnas de chatbot en tenants si no existen
    await clientInstance.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS chatbot_enabled BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS chatbot_welcome_message TEXT DEFAULT '¡Hola! ¿En qué puedo ayudarte hoy?';
    `);

    // Crear tabla de mensajes de chat si no existe
    await clientInstance.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
      );
    `);

    // Crear índice para búsquedas rápidas por sesión si no existe
    await clientInstance.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(tenant_id, session_id);
    `);

    // Asegurar columna addon_minutes en tenants si no existe
    await clientInstance.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS addon_minutes INTEGER DEFAULT 0;
    `);

    // 3. Notificar a PostgREST
    await clientInstance.query("NOTIFY pgrst, 'reload schema';");
  };

  let migrationSuccess = false;
  let lastErrorMsg = '';

  for (const password of passwordsToTry) {
    // Opción 1: Conexión Directa (Puerto 5432)
    try {
      console.log(`[Bootstrap Migration] Intentando conexión DIRECTA (puerto 5432) con contraseña ${password.substring(0, 3)}...`);
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
      console.log('[Bootstrap Migration] ¡Conexión DIRECTA exitosa!');
      await query(client);
      console.log('[Bootstrap Migration] ✅ Migración completada con éxito (Conexión Directa).');
      await client.end();
      migrationSuccess = true;
      break;
    } catch (directErr: any) {
      console.warn('[Bootstrap Migration WARNING] Falló la conexión directa:', directErr.message);
      lastErrorMsg = `Direct: ${directErr.message}`;
    }

    // Opción 2: Conexión Pooler (Puerto 6543)
    try {
      console.log(`[Bootstrap Migration] Intentando conexión vía POOLER (puerto 6543) con contraseña ${password.substring(0, 3)}...`);
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
      console.log('[Bootstrap Migration] ¡Conexión por POOLER exitosa!');
      await query(client);
      console.log('[Bootstrap Migration] ✅ Migración completada con éxito (Conexión Pooler).');
      await client.end();
      migrationSuccess = true;
      break;
    } catch (poolErr: any) {
      console.error('[Bootstrap Migration ERROR] Falló también la conexión por pooler:', poolErr.message);
      lastErrorMsg = `Pooler: ${poolErr.message}`;
    }
  }

  if (!migrationSuccess) {
    console.error(`[Bootstrap Migration CRITICAL] Fallaron todas las opciones de conexión para las migraciones. Último error: ${lastErrorMsg}`);
  }
}

// Función para resincronizar todos los agentes a medianoche para mantener la fecha del sistema actualizada en el prompt de Retell
async function syncAllAgentsWithRetell() {
  console.log('🏁 [Cron Job Diario] Iniciando resincronización de todos los agentes de Retell para actualizar fecha actual...');
  try {
    const { data: tenants, error } = await supabase.from('tenants').select('*');
    if (error) {
      console.error('❌ [Cron Job Diario] Error al obtener inquilinos de Supabase:', error.message);
      return;
    }

    if (!tenants || tenants.length === 0) {
      console.log('ℹ️ [Cron Job Diario] No hay inquilinos registrados.');
      return;
    }

    const webhookBaseUrl = 'https://corandar.onrender.com';
    for (const tenant of tenants) {
      if (!tenant.retell_agent_id) continue;
      try {
        await syncTenantWithRetell(tenant, webhookBaseUrl);
        console.log(`✅ [Cron Job Diario] Agente ${tenant.retell_agent_id} de ${tenant.email} sincronizado con la fecha de hoy.`);
      } catch (err: any) {
        console.error(`❌ [Cron Job Diario] Error al sincronizar ${tenant.email}:`, err.message);
      }
    }
    console.log('🎉 [Cron Job Diario] Resincronización diaria de agentes completada con éxito.');
    
    // Purgar recuerdos antiguos (> 7 días)
    await purgeOldCallerMemories();
  } catch (err: any) {
    console.error('❌ [Cron Job Diario] Error general en el job de sincronización:', err.message);
  }
}

// Función para eliminar recuerdos de llamadas que tengan más de 7 días de antigüedad
async function purgeOldCallerMemories() {
  console.log('🧹 [Cron Job Diario] Iniciando purga de recuerdos de caller_memories antiguos (> 7 días)...');
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const limitISO = sevenDaysAgo.toISOString();

    const { count, error } = await supabase
      .from('caller_memories')
      .delete({ count: 'exact' })
      .lt('created_at', limitISO);

    if (error) {
      console.error('❌ [Cron Job Diario] Error al purgar recuerdos antiguos:', error.message);
    } else {
      console.log(`✅ [Cron Job Diario] Purga de recuerdos completada. Se eliminaron ${count || 0} registros antiguos.`);
    }
  } catch (err: any) {
    console.error('❌ [Cron Job Diario] Error general en el job de purga de recuerdos:', err.message);
  }
}

// Programar la ejecución diaria a las 00:00:00 hora de España
function scheduleDailyAgentSync() {
  const getMsUntilMidnight = (): number => {
    const now = new Date();
    // Obtener la hora actual en la zona horaria de Madrid (España)
    const formatter = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    const parts = formatter.formatToParts(now);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    const second = parseInt(parts.find(p => p.type === 'second')?.value || '0', 10);

    const msSinceMidnight = ((hour * 60 + minute) * 60 + second) * 1000;
    const msInADay = 24 * 60 * 60 * 1000;
    
    return msInADay - msSinceMidnight;
  };

  const msUntilMidnight = getMsUntilMidnight();
  console.log(`⏰ [Scheduler] Siguiente sincronización diaria programada en ${Math.round(msUntilMidnight / 1000 / 60)} minutos (a medianoche hora España).`);

  // Programar a medianoche
  setTimeout(async () => {
    await syncAllAgentsWithRetell();
    // Programar intervalo recurrente cada 24 horas
    setInterval(syncAllAgentsWithRetell, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  // Ejecutar una primera sincronización al arrancar en segundo plano para asegurar consistencia tras despliegues o reinicios
  setTimeout(() => {
    console.log('🚀 [Scheduler] Iniciando sincronización de agentes inicial en segundo plano...');
    syncAllAgentsWithRetell().catch(err => console.error('Error en sincronización diaria inicial:', err));
  }, 10000); // 10 segundos después del arranque
}

// Arrancar el servidor
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(` Servidor SanaSalud escuchando en: http://localhost:${PORT}`);
  console.log(`========================================\n`);
  
  // Ejecutar migraciones
  runDatabaseMigrations().catch(err => {
    console.error('[Bootstrap Migration] Error en migración inicial:', err.message);
  });

  // Arrancar automáticamente las sesiones activas de WhatsApp Web en segundo plano
  autoStartActiveSessions().catch(err => {
    console.error('[WhatsApp Web Boot] Error al arrancar sesiones de WhatsApp:', err.message);
  });

  // Arrancar scheduler de sincronización diaria de fecha en prompts de agentes
  scheduleDailyAgentSync();
});
