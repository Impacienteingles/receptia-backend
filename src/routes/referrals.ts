import { Router, Request, Response } from 'express';
import { supabase, getSettingVal } from '../services/supabase';

const router = Router();

/**
 * Helper para guardar un ajuste de forma segura en la tabla settings
 */
async function saveSetting(key: string, value: string): Promise<void> {
  await supabase
    .from('settings')
    .upsert({ key, value });
}

/**
 * GET /config: Obtiene la configuración global de la promoción de referidos
 */
router.get('/config', async (req: Request, res: Response) => {
  try {
    const referralsPromoEnabled = await getSettingVal('referrals_promo_enabled') || 'false';
    const referralsCommissionType = await getSettingVal('referrals_commission_type') || 'percentage';
    const referralsCommissionValue = await getSettingVal('referrals_commission_value') || '10';

    res.json({
      enabled: referralsPromoEnabled === 'true',
      commissionType: referralsCommissionType,
      commissionValue: Number(referralsCommissionValue)
    });
  } catch (err: any) {
    console.error('[Referrals API] Error fetching config:', err.message);
    res.status(500).json({ error: 'Error al obtener la configuración de referidos.', details: err.message });
  }
});

/**
 * POST /config: Guarda la configuración global de la promoción de referidos (Admin)
 */
router.post('/config', async (req: Request, res: Response) => {
  const { enabled, commissionType, commissionValue } = req.body;

  if (commissionType !== 'percentage' && commissionType !== 'fixed') {
    return res.status(400).json({ error: 'El tipo de comisión debe ser percentage o fixed.' });
  }

  if (commissionValue === undefined || isNaN(Number(commissionValue)) || Number(commissionValue) < 0) {
    return res.status(400).json({ error: 'El valor de la comisión debe ser un número válido mayor o igual a 0.' });
  }

  try {
    await saveSetting('referrals_promo_enabled', enabled ? 'true' : 'false');
    await saveSetting('referrals_commission_type', commissionType);
    await saveSetting('referrals_commission_value', String(commissionValue));

    console.log(`[Referrals Config] Configuración actualizada: Enabled=${enabled}, Type=${commissionType}, Value=${commissionValue}`);
    res.json({ status: 'success', message: 'Configuración de referidos guardada con éxito.' });
  } catch (err: any) {
    console.error('[Referrals API] Error saving config:', err.message);
    res.status(500).json({ error: 'Error al guardar la configuración de referidos.', details: err.message });
  }
});

/**
 * POST /register: Registra un nuevo referido apadrinado por un cliente activo
 */
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { referrer_tenant_id, referred_name, referred_email, referred_phone, referred_company } = req.body;

  if (!referrer_tenant_id || !referred_name || !referred_email || !referred_phone) {
    res.status(400).json({ error: 'Faltan campos obligatorios para el registro.' });
    return;
  }

  try {
    // 1. Validar auto-referidos
    const { data: referrer, error: refErr } = await supabase
      .from('tenants')
      .select('email, business_name')
      .eq('id', referrer_tenant_id)
      .single();

    if (refErr || !referrer) {
      res.status(400).json({ error: 'El inquilino referidor no es válido o no existe.' });
      return;
    }

    if (referrer.email.trim().toLowerCase() === referred_email.trim().toLowerCase()) {
      res.status(400).json({ error: 'No está permitido auto-referirse a sí mismo.' });
      return;
    }

    // 2. Validar duplicados (si el referido ya ha sido apadrinado)
    const { data: existing } = await supabase
      .from('referrals')
      .select('id')
      .eq('referred_email', referred_email.trim().toLowerCase())
      .maybeSingle();

    if (existing) {
      res.status(400).json({ error: 'Este cliente ya ha sido recomendado o registrado anteriormente.' });
      return;
    }

    // 3. Consultar la configuración global activa en este instante
    const referralsPromoEnabled = await getSettingVal('referrals_promo_enabled') || 'false';
    if (referralsPromoEnabled !== 'true') {
      res.status(400).json({ error: 'La promoción de referidos se encuentra inactiva en este momento.' });
      return;
    }

    const commissionType = await getSettingVal('referrals_commission_type') || 'percentage';
    const commissionValue = await getSettingVal('referrals_commission_value') || '10';

    // 4. Insertar el referido guardando el tipo y valor de comisión congelados
    const { data, error } = await supabase
      .from('referrals')
      .insert({
        referrer_tenant_id,
        referred_name,
        referred_email: referred_email.trim().toLowerCase(),
        referred_phone,
        referred_company,
        status: 'pending',
        commission_type: commissionType,
        commission_value: Number(commissionValue)
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`[Referrals] Registrado nuevo referido: ${referred_name} por referidor ${referrer.business_name}`);
    res.json({ status: 'success', referral: data });
  } catch (err: any) {
    console.error('[Referrals API] Error registering referral:', err.message);
    res.status(500).json({ error: 'Error al registrar el referido.', details: err.message });
  }
});

/**
 * GET /my-referrals: Obtiene la lista de referidos y desglose de ganancias para un cliente específico
 */
router.get('/my-referrals', async (req: Request, res: Response): Promise<void> => {
  const { tenant_id } = req.query;

  if (!tenant_id) {
    res.status(400).json({ error: 'El parámetro tenant_id es obligatorio.' });
    return;
  }

  try {
    // 1. Obtener referidos
    const { data: referrals, error: refErr } = await supabase
      .from('referrals')
      .select('*')
      .eq('referrer_tenant_id', tenant_id)
      .order('created_at', { ascending: false });

    if (refErr) throw refErr;

    // 2. Obtener comisiones
    const { data: commissions, error: comErr } = await supabase
      .from('referral_commissions')
      .select('*')
      .eq('referrer_tenant_id', tenant_id);

    if (comErr) throw comErr;

    // 3. Procesar desglose y métricas
    let totalPending = 0;
    let totalApplied = 0;
    let monthlyEstimation = 0;

    commissions.forEach(c => {
      if (c.status === 'pending') {
        totalPending += Number(c.amount);
      } else if (c.status === 'applied') {
        totalApplied += Number(c.amount);
      }
    });

    // Calcular la proyección de comisiones mensuales basada en referidos activos que tienen modalidad porcentaje
    // Buscamos los referidos suscritos y calculamos su estimación en base al plan que tienen contratado
    const activeReferrals = referrals.filter(r => r.status === 'subscribed');
    for (const ref of activeReferrals) {
      if (ref.commission_type === 'percentage' && ref.referred_tenant_id) {
        // Consultar el precio del plan del referido
        const { data: referredTenant } = await supabase
          .from('tenants')
          .select('subscription_status, plan_id')
          .eq('id', ref.referred_tenant_id)
          .maybeSingle();

        if (referredTenant && referredTenant.subscription_status === 'active') {
          // Asumir coste estimado del plan
          const planPrices: Record<string, number> = {
            estandar_mensual: 49.00,
            premium_mensual: 99.00,
            estandar_anual: 39.00,
            premium_anual: 79.00,
            estandar: 49.00,
            premium: 99.00
          };
          const planCost = planPrices[referredTenant.plan_id] || 49.00;
          monthlyEstimation += planCost * (Number(ref.commission_value) / 100);
        }
      }
    }

    res.json({
      referrals,
      commissions,
      metrics: {
        totalEarned: totalPending + totalApplied,
        pendingBalance: totalPending,
        appliedBalance: totalApplied,
        monthlyEstimation: Math.round(monthlyEstimation * 100) / 100
      }
    });
  } catch (err: any) {
    console.error('[Referrals API] Error fetching my referrals:', err.message);
    res.status(500).json({ error: 'Error al obtener los datos de referidos.', details: err.message });
  }
});

/**
 * GET /admin/all: Devuelve métricas globales y listado completo de todos los referidos (Admin)
 */
router.get('/admin/all', async (req: Request, res: Response) => {
  try {
    // 1. Obtener todos los referidos con datos del referidor
    const { data: referrals, error: refErr } = await supabase
      .from('referrals')
      .select(`
        *,
        referrer:tenants!referrals_referrer_tenant_id_fkey(business_name, email)
      `)
      .order('created_at', { ascending: false });

    if (refErr) throw refErr;

    // 2. Obtener todas las comisiones
    const { data: commissions, error: comErr } = await supabase
      .from('referral_commissions')
      .select(`
        *,
        referral:referrals(referred_name, referred_company),
        referrer:tenants(business_name, email)
      `)
      .order('created_at', { ascending: false });

    if (comErr) throw comErr;

    // 3. Obtener balances por cliente referidor
    const referrerBalances: Record<string, { business_name: string; email: string; pending: number; applied: number }> = {};
    
    commissions.forEach(c => {
      const referrerId = c.referrer_tenant_id;
      if (!referrerBalances[referrerId]) {
        referrerBalances[referrerId] = {
          business_name: c.referrer?.business_name || 'Desconocido',
          email: c.referrer?.email || '',
          pending: 0,
          applied: 0
        };
      }
      if (c.status === 'pending') {
        referrerBalances[referrerId].pending += Number(c.amount);
      } else if (c.status === 'applied') {
        referrerBalances[referrerId].applied += Number(c.amount);
      }
    });

    res.json({
      referrals,
      commissions,
      balances: Object.entries(referrerBalances).map(([id, val]) => ({
        referrer_id: id,
        ...val
      }))
    });
  } catch (err: any) {
    console.error('[Referrals API] Error fetching admin referrals:', err.message);
    res.status(500).json({ error: 'Error al obtener datos globales de referidos.', details: err.message });
  }
});

/**
 * GET /admin/accounting: Obtiene el extracto contable y conciliación de comisiones de referidos
 */
router.get('/admin/accounting', async (req: Request, res: Response) => {
  try {
    const { data: commissions, error } = await supabase
      .from('referral_commissions')
      .select(`
        amount,
        status,
        created_at,
        referrer:tenants(business_name)
      `);

    if (error) throw error;

    // Calcular estadísticas contables
    let totalDevenged = 0;
    let totalPending = 0;
    let totalApplied = 0;

    commissions.forEach(c => {
      const amt = Number(c.amount);
      totalDevenged += amt;
      if (c.status === 'pending') {
        totalPending += amt;
      } else if (c.status === 'applied') {
        totalApplied += amt;
      }
    });

    // Agrupación contable por meses
    const monthlySummary: Record<string, { devenged: number; applied: number }> = {};
    commissions.forEach(c => {
      const month = new Date(c.created_at).toISOString().substring(0, 7); // 'YYYY-MM'
      if (!monthlySummary[month]) {
        monthlySummary[month] = { devenged: 0, applied: 0 };
      }
      const amt = Number(c.amount);
      monthlySummary[month].devenged += amt;
      if (c.status === 'applied') {
        monthlySummary[month].applied += amt;
      }
    });

    res.json({
      summary: {
        totalDevenged,
        totalPending,
        totalApplied,
        unreconciledDiscrepancy: totalDevenged - (totalPending + totalApplied) // Debería ser siempre 0
      },
      monthlySummary: Object.entries(monthlySummary).map(([month, val]) => ({
        month,
        ...val
      })).sort((a, b) => b.month.localeCompare(a.month))
    });
  } catch (err: any) {
    console.error('[Referrals API] Error fetching admin accounting:', err.message);
    res.status(500).json({ error: 'Error al obtener extractos contables.', details: err.message });
  }
});

export default router;
