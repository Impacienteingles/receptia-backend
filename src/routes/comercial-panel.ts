import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../services/supabase';
import nodemailer from 'nodemailer';

// Extender Express Request para almacenar la entidad comercial autenticada
interface ComercialRequest extends Request {
  comercial?: any;
}

const router = Router();

/**
 * Helper: Generar comisión inicial o única si se marca como contratado
 */
async function generateCommissionOnContratado(prospectId: string) {
  try {
    // 1. Obtener el prospecto
    const { data: prospect, error: pErr } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', prospectId)
      .single();

    if (pErr || !prospect || !prospect.commercial_agent_id) return;

    // 2. Obtener el comercial
    const { data: agent, error: cErr } = await supabase
      .from('commercial_agents')
      .select('*')
      .eq('id', prospect.commercial_agent_id)
      .single();

    if (cErr || !agent || agent.status !== 'active') return;

    // 3. Verificar si ya se ha generado alguna comisión para este prospecto
    const { data: existing } = await supabase
      .from('commissions')
      .select('id')
      .eq('prospect_id', prospectId)
      .maybeSingle();

    if (existing) return; // Evitar duplicar comisión por doble click

    const todayPeriod = new Date().toISOString().substring(0, 7); // 'YYYY-MM'

    if (agent.commission_type === 'fixed') {
      // Importe fijo único
      await supabase
        .from('commissions')
        .insert({
          agent_id: agent.id,
          prospect_id: prospectId,
          type: 'fixed',
          amount: Number(agent.commission_value),
          paid: false,
          period: 'unique'
        });
      console.log(`[Comercial Commission] Comisión fija única de ${agent.commission_value}€ registrada para ${agent.name}`);
    } else if (agent.commission_type === 'percentage') {
      // Porcentaje recurrente
      // Obtener el precio del plan del inquilino (demo o real)
      let planPrice = 149.00; // Por defecto Plan Estándar
      if (prospect.demo_tenant_id) {
        const { data: tenant } = await supabase
          .from('tenants')
          .select('price_amount')
          .eq('id', prospect.demo_tenant_id)
          .single();
        if (tenant && tenant.price_amount) {
          planPrice = Number(tenant.price_amount);
        }
      }

      const commissionAmount = planPrice * (Number(agent.commission_value) / 100);

      await supabase
        .from('commissions')
        .insert({
          agent_id: agent.id,
          prospect_id: prospectId,
          type: 'percentage',
          amount: commissionAmount,
          paid: false,
          period: todayPeriod
        });
      console.log(`[Comercial Commission] Comisión inicial del %${agent.commission_value} (${commissionAmount}€) registrada para ${agent.name}`);
    }
  } catch (err: any) {
    console.error('[Commission Auto-Generation Error]:', err.message);
  }
}

/**
 * Middleware de Autenticación de Comercial
 */
async function requireComercialAuth(req: ComercialRequest, res: Response, next: NextFunction): Promise<void> {
  const comercialId = req.headers['x-comercial-id'] as string;
  const pin = req.headers['x-comercial-pin'] as string;

  if (!comercialId || !pin) {
    res.status(401).json({ error: 'Falta ID de comercial o PIN en los headers.' });
    return;
  }

  try {
    const { data: agent, error } = await supabase
      .from('commercial_agents')
      .select('*')
      .eq('id', comercialId)
      .eq('pin', pin.trim())
      .single();

    if (error || !agent) {
      res.status(401).json({ error: 'Acceso no autorizado. PIN incorrecto.' });
      return;
    }

    if (agent.status !== 'active') {
      res.status(403).json({ error: 'El agente comercial está desactivado.' });
      return;
    }

    req.comercial = {
      ...agent,
      commission_mode: agent.commission_type,
      stripe_connect_account_id: agent.stripe_account_id
    };
    next();
  } catch (err) {
    res.status(401).json({ error: 'Error de autenticación.' });
  }
}

/**
 * Obtener email y nombre de comercial por access_url (público para pre-login)
 */
router.get('/auth/agent-by-url/:accessUrl', async (req: Request, res: Response): Promise<void> => {
  const { accessUrl } = req.params;
  console.log(`[Comercial Auth] Buscando agente por access_url: "${accessUrl}"`);
  try {
    const { data: agent, error } = await supabase
      .from('commercial_agents')
      .select('id, name, email')
      .eq('access_url', accessUrl)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      console.error(`[Comercial Auth] Error de Supabase:`, error.message);
      res.status(404).json({ error: 'URL de acceso no válida o agente inactivo.' });
      return;
    }

    if (!agent) {
      console.warn(`[Comercial Auth] No se encontró agente activo con access_url="${accessUrl}".`);
      res.status(404).json({ error: 'URL de acceso no válida o agente inactivo.' });
      return;
    }

    console.log(`[Comercial Auth] Agente encontrado: ${agent.name} (${agent.email})`);
    res.json({ success: true, agent });
  } catch (err: any) {
    console.error(`[Comercial Auth] Error inesperado:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Diagnóstico: listar access_urls de todos los agentes (temporal - usar solo para depuración)
 */
router.get('/auth/debug-agents', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data: agents, error } = await supabase
      .from('commercial_agents')
      .select('id, name, email, access_url, status, pin');

    if (error) {
      console.error('[Comercial Debug] Error:', error.message);
      res.status(500).json({ error: error.message });
      return;
    }

    const sanitized = (agents || []).map(a => ({
      id: a.id,
      name: a.name,
      email: a.email,
      access_url: a.access_url,
      access_url_length: a.access_url ? a.access_url.length : 0,
      access_url_chars: a.access_url ? [...a.access_url].map(c => `${c}(${c.charCodeAt(0)})`) : [],
      pin_length: a.pin ? a.pin.length : 0,
      pin_chars: a.pin ? [...a.pin].map(c => `${c}(${c.charCodeAt(0)})`) : [],
      status: a.status
    }));

    console.log('[Comercial Debug] Agentes encontrados:', JSON.stringify(sanitized, null, 2));
    res.json({ success: true, agents: sanitized, count: sanitized.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/recover', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: 'El correo electrónico es requerido.' });
    return;
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const { data: agent, error } = await supabase
      .from('commercial_agents')
      .select('name, email, pin, status')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (error) throw error;

    if (!agent) {
      res.status(404).json({ error: 'El correo electrónico no está registrado como agente comercial.' });
      return;
    }

    if (agent.status !== 'active') {
      res.status(403).json({ error: 'El agente comercial está inactivo.' });
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
        connectionTimeoutMs: 5000
      } as any);
      mailFrom = process.env.SMTP_USER;
    } else if (process.env.GOOGLE_EMAIL && process.env.GOOGLE_PASSWORD) {
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.GOOGLE_EMAIL,
          pass: process.env.GOOGLE_PASSWORD
        },
        connectionTimeout: 5000
      } as any);
      mailFrom = process.env.GOOGLE_EMAIL;
    }

    if (transporter && mailFrom) {
      const mailOptions = {
        from: `"Soporte Receptia" <${mailFrom}>`,
        to: normalizedEmail,
        subject: `Recuperación de Contraseña Comercial - Receptia`,
        html: `
          <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 30px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h2 style="color: #7c3aed; margin: 0; font-size: 24px;">Receptia</h2>
              <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Recuperación de credenciales comerciales</p>
            </div>
            <div style="font-size: 16px; color: #1e293b; line-height: 1.6; margin-bottom: 24px;">
              <p>Hola, <strong>${agent.name}</strong>:</p>
              <p>Hemos recibido una solicitud para recuperar tu contraseña de acceso al panel de agente comercial de Receptia.</p>
              <div style="text-align: center; background-color: #f8fafc; border: 1px solid #cbd5e1; padding: 20px; border-radius: 12px; margin: 24px 0;">
                <p style="font-size: 13px; color: #64748b; margin: 0; text-transform: uppercase; letter-spacing: 0.05em;">Tu contraseña de acceso es:</p>
                <p style="font-size: 36px; font-weight: bold; color: #1e293b; letter-spacing: 0.1em; margin: 8px 0 0 0;">${agent.pin}</p>
              </div>
              <p style="font-size: 14px; color: #64748b;">Si no has solicitado esta recuperación, por favor te sugerimos cambiar tu contraseña desde el panel comercial o ponerte en contacto con soporte.</p>
            </div>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin-bottom: 20px;" />
            <div style="text-align: center; font-size: 12px; color: #94a3b8;">
              <p>© 2026 Receptia. Todos los derechos reservados.</p>
            </div>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
      res.json({ success: true, message: 'La contraseña de comercial ha sido enviada automáticamente a tu correo electrónico registrado.' });
    } else {
      res.status(500).json({ error: 'El servicio de envío de correos no está configurado en el servidor.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 1. Autenticación / Login
 */
router.post('/auth/login', async (req: Request, res: Response): Promise<void> => {
  const { email, pin, access_url } = req.body;

  console.log(`[Comercial Login] Intento de login - Modo: ${email ? 'email' : access_url ? 'access_url' : 'desconocido'}, Email: ${email || 'N/A'}, AccessURL: ${access_url || 'N/A'}, PIN: ${'*'.repeat((pin || '').length)}`);

  if (!pin) {
    console.warn('[Comercial Login] PIN no proporcionado.');
    res.status(400).json({ error: 'El PIN es requerido.' });
    return;
  }

  try {
    let query = supabase.from('commercial_agents').select('*');
    if (email) {
      const normalizedEmail = email.trim().toLowerCase();
      console.log(`[Comercial Login] Buscando por email: "${normalizedEmail}"`);
      query = query.eq('email', normalizedEmail);
    } else if (access_url) {
      const normalizedUrl = access_url.trim();
      console.log(`[Comercial Login] Buscando por access_url: "${normalizedUrl}"`);
      query = query.eq('access_url', normalizedUrl);
    } else {
      console.warn('[Comercial Login] Ni email ni access_url proporcionados.');
      res.status(400).json({ error: 'Email o URL de acceso única son requeridos.' });
      return;
    }

    const { data: agent, error } = await query.eq('pin', pin.trim()).maybeSingle();

    if (error) {
      console.error('[Comercial Login] Error de Supabase:', error.message);
      res.status(401).json({ error: 'Credenciales inválidas.' });
      return;
    }

    if (!agent) {
      console.warn(`[Comercial Login] No se encontró agente con las credenciales proporcionadas.`);
      res.status(401).json({ error: 'Credenciales inválidas.' });
      return;
    }

    if (agent.status !== 'active') {
      console.warn(`[Comercial Login] Agente "${agent.name}" está inactivo.`);
      res.status(403).json({ error: 'El agente comercial está inactivo.' });
      return;
    }

    console.log(`[Comercial Login] Login exitoso para "${agent.name}" (ID: ${agent.id})`);
    res.json({
      success: true,
      comercial_id: agent.id,
      name: agent.name
    });
  } catch (err: any) {
    console.error('[Comercial Login] Error inesperado:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 2. Obtener perfil
 */
router.get('/profile', requireComercialAuth, async (req: ComercialRequest, res: Response): Promise<void> => {
  res.json({ success: true, comercial: req.comercial });
});

/**
 * 3. Obtener leads asignados
 */
router.get('/leads', requireComercialAuth, async (req: ComercialRequest, res: Response): Promise<void> => {
  try {
    const { data: leads, error } = await supabase
      .from('prospects')
      .select(`
        *,
        tenants:demo_tenant_id (
          contract_start_date
        )
      `)
      .eq('commercial_agent_id', req.comercial.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Obtener los logs de cambio de clasificación a no_interesado
    const { data: logs } = await supabase
      .from('lead_activity_log')
      .select('prospect_id, created_at')
      .eq('action_type', 'status_change')
      .eq('new_status', 'no_interesado')
      .eq('agent_id', req.comercial.id)
      .order('created_at', { ascending: false });

    const noInterestTimes: { [key: string]: string } = {};
    if (logs) {
      logs.forEach((log: any) => {
        if (!noInterestTimes[log.prospect_id]) {
          noInterestTimes[log.prospect_id] = log.created_at;
        }
      });
    }

    const now = Date.now();
    const filtered = (leads || []).map((l: any) => ({
      ...l,
      comercial_id: l.commercial_agent_id
    })).filter((lead: any) => {
      if (lead.classification !== 'no_interesado') {
        return true;
      }
      const logTime = noInterestTimes[lead.id];
      const timeToCheck = logTime ? new Date(logTime).getTime() : new Date(lead.created_at).getTime();
      const diffMins = (now - timeToCheck) / (1000 * 60);
      return diffMins < 30;
    });

    res.json({ success: true, leads: filtered });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 4. Actualizar estado comercial de un lead / Registrar nota
 */
router.patch('/leads/:id', requireComercialAuth, async (req: ComercialRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const { classification, notes } = req.body;

  try {
    if (classification === 'contratado') {
      res.status(400).json({ error: 'El estado Contratado se activa automáticamente al realizar el pago.' });
      return;
    }

    // Verificar que el lead pertenece al comercial
    const { data: lead, error: fetchErr } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', id)
      .eq('commercial_agent_id', req.comercial.id)
      .single();

    if (fetchErr || !lead) {
      res.status(404).json({ error: 'Lead no encontrado o no asignado a este comercial.' });
      return;
    }

    const updates: any = {};
    const activitiesToInsert: any[] = [];

    // Cambiar estado/clasificación si aplica
    if (classification && classification !== lead.classification) {
      updates.classification = classification;
      
      // Registrar log de cambio de estado
      activitiesToInsert.push({
        prospect_id: id,
        agent_id: req.comercial.id,
        action_type: 'status_change',
        previous_status: lead.classification || 'no_contactado',
        new_status: classification,
        note: notes || `Cambio de estado comercial a: ${classification}`
      });
    }

    // Añadir una nota simple si no hubo cambio de estado pero sí texto
    if (notes && (!classification || classification === lead.classification)) {
      activitiesToInsert.push({
        prospect_id: id,
        agent_id: req.comercial.id,
        action_type: 'note',
        previous_status: lead.classification || 'no_contactado',
        new_status: lead.classification || 'no_contactado',
        note: notes
      });
    }

    // Guardar cambios en prospects
    if (Object.keys(updates).length > 0) {
      const { error: updErr } = await supabase
        .from('prospects')
        .update(updates)
        .eq('id', id);
        
      if (updErr) throw updErr;
    }

    // Insertar actividades en lead_activity_log
    if (activitiesToInsert.length > 0) {
      const { error: actErr } = await supabase
        .from('lead_activity_log')
        .insert(activitiesToInsert);
        
      if (actErr) throw actErr;
    }

    // Si pasa a Contratado, disparar la creación de comisiones
    if (classification === 'contratado' && lead.classification !== 'contratado') {
      await generateCommissionOnContratado(id as string);
    }

    res.json({ success: true, message: 'Lead actualizado correctamente.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 5. Obtener actividades de un lead
 */
router.get('/leads/:id/activities', requireComercialAuth, async (req: ComercialRequest, res: Response): Promise<void> => {
  const id = req.params.id as string;

  try {
    // Validar asignación
    const { data: lead, error: fetchErr } = await supabase
      .from('prospects')
      .select('id')
      .eq('id', id)
      .eq('commercial_agent_id', req.comercial.id)
      .single();

    if (fetchErr || !lead) {
      res.status(404).json({ error: 'Lead no asignado a este comercial.' });
      return;
    }

    const { data: activities, error } = await supabase
      .from('lead_activity_log')
      .select('*')
      .eq('prospect_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const mappedActivities = (activities || []).map((act: any) => ({
      ...act,
      comercial_id: act.agent_id,
      action: act.action_type,
      from_status: act.previous_status,
      to_status: act.new_status,
      notes: act.note
    }));

    res.json({ success: true, activities: mappedActivities });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 6. Obtener comisiones, proyecciones e historial de pagos
 */
router.get('/commissions', requireComercialAuth, async (req: ComercialRequest, res: Response): Promise<void> => {
  try {
    // 1. Obtener comisiones
    const { data: commissions, error: comErr } = await supabase
      .from('commissions')
      .select(`
        *,
        prospects (
          business_name,
          email,
          phone,
          demo_tenant_id
        )
      `)
      .eq('agent_id', req.comercial.id)
      .order('created_at', { ascending: false });

    if (comErr) throw comErr;

    const tenantIds = (commissions || [])
      .map((com: any) => com.prospects?.demo_tenant_id)
      .filter(Boolean);

    let tenants: any[] = [];
    if (tenantIds.length > 0) {
      const { data: tData } = await supabase
        .from('tenants')
        .select('id, business_name, subscription_plan, price_amount')
        .in('id', tenantIds);
      tenants = tData || [];
    }

    const now = new Date();
    const mappedCommissions = (commissions || []).map((com: any) => {
      const tenant = tenants.find((t: any) => t.id === com.prospects?.demo_tenant_id);
      
      const comCreated = new Date(com.created_at);
      const diffTime = now.getTime() - comCreated.getTime();
      const diffDays = diffTime / (1000 * 60 * 60 * 24);
      const inTrial = diffDays < 7;

      return {
        ...com,
        comercial_id: com.agent_id,
        status: com.paid ? 'paid' : (inTrial ? 'trial' : 'pending'),
        payout_id: com.payment_id,
        tenants: tenant ? {
          business_name: tenant.business_name,
          subscription_plan: tenant.subscription_plan,
          price_amount: tenant.price_amount
        } : null
      };
    });

    // 2. Obtener payouts recibidos
    const { data: payouts, error: payErr } = await supabase
      .from('commission_payments')
      .select('*')
      .eq('agent_id', req.comercial.id)
      .order('created_at', { ascending: false });

    if (payErr) throw payErr;

    const mappedPayouts = (payouts || []).map((p: any) => ({
      ...p,
      comercial_id: p.agent_id,
      amount: p.total_amount,
      commission_recurring_amount: p.recurrent_amount,
      commission_fixed_amount: p.fixed_amount,
      payment_method: p.method
    }));

    // 3. Calcular totales
    const totalPending = mappedCommissions
      .filter((com: any) => com.status === 'pending')
      .reduce((sum, com) => sum + Number(com.amount), 0);

    const totalPaid = mappedCommissions
      .filter((com: any) => com.status === 'paid')
      .reduce((sum, com) => sum + Number(com.amount), 0);

    const totalEarned = totalPending + totalPaid;

    // Calcular MRR Estimado (para comisiones recurrentes por clientes activos)
    let estimatedMonthlyRecurring = 0;
    if (req.comercial.commission_mode === 'percentage') {
      // Obtener todos los inquilinos referidos que estén activos
      const { data: prospects } = await supabase
        .from('prospects')
        .select('demo_tenant_id')
        .eq('commercial_agent_id', req.comercial.id)
        .eq('classification', 'contratado');

      const tenantIds = (prospects || []).map(p => p.demo_tenant_id).filter(Boolean);
      
      if (tenantIds.length > 0) {
        const { data: activeTenants } = await supabase
          .from('tenants')
          .select('price_amount, contract_start_date')
          .in('id', tenantIds)
          .eq('subscription_status', 'active');

        const totalActiveBilling = (activeTenants || [])
          .filter((t: any) => {
            if (!t.contract_start_date) return true; // Fallback
            const contractStart = new Date(t.contract_start_date);
            const now = new Date();
            const diffDays = (now.getTime() - contractStart.getTime()) / (1000 * 60 * 60 * 24);
            return diffDays >= 7; // Solo clientes reales
          })
          .reduce((sum, t) => sum + Number(t.price_amount || 0), 0);
        estimatedMonthlyRecurring = totalActiveBilling * (Number(req.comercial.commission_value) / 100);
      }
    }

    res.json({
      success: true,
      commissions: mappedCommissions,
      payouts: mappedPayouts,
      metrics: {
        totalEarned,
        totalPending,
        totalPaid,
        estimatedMonthlyRecurring
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/change-password', requireComercialAuth, async (req: ComercialRequest, res: Response): Promise<void> => {
  const { current_pin, new_pin } = req.body;

  if (!current_pin || !new_pin) {
    res.status(400).json({ error: 'La contraseña actual y la nueva son obligatorias.' });
    return;
  }

  if (new_pin.length < 8 || !/^[a-zA-Z0-9]+$/.test(new_pin)) {
    res.status(400).json({ error: 'La nueva contraseña debe ser alfanumérica y tener al menos 8 caracteres.' });
    return;
  }

  // Validar contraseña actual
  if (current_pin.trim() !== req.comercial.pin.trim()) {
    res.status(403).json({ error: 'La contraseña actual introducida es incorrecta.' });
    return;
  }

  try {
    const { error } = await supabase
      .from('commercial_agents')
      .update({ pin: new_pin.trim() })
      .eq('id', req.comercial.id);

    if (error) throw error;

    res.json({ success: true, message: 'Contraseña actualizada correctamente.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
export { generateCommissionOnContratado };
