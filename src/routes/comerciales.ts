import { Router, Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { getStripeClient } from '../services/stripe';

const router = Router();

/**
 * Helper: Map database agent to frontend comercial object
 */
function mapAgentToComercial(agent: any) {
  if (!agent) return null;
  return {
    ...agent,
    commission_mode: agent.commission_type,
    stripe_connect_account_id: agent.stripe_account_id,
    payment_method: agent.stripe_account_id ? 'stripe' : 'manual'
  };
}

/**
 * 1. Listar comerciales con sus estadísticas y saldos
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data: agents, error: cErr } = await supabase
      .from('commercial_agents')
      .select('*')
      .order('name', { ascending: true });

    if (cErr) throw cErr;

    const { data: prospects, error: pErr } = await supabase
      .from('prospects')
      .select('id, commercial_agent_id, classification');
      
    if (pErr) throw pErr;

    const { data: commissions, error: comErr } = await supabase
      .from('commissions')
      .select('id, agent_id, type, amount, paid');

    if (comErr) throw comErr;

    const { data: payouts, error: payErr } = await supabase
      .from('commission_payments')
      .select('id, agent_id, total_amount');

    if (payErr) throw payErr;

    const list = (agents || []).map((agent: any) => {
      const myProspects = (prospects || []).filter((p: any) => p.commercial_agent_id === agent.id);
      const myCommissions = (commissions || []).filter((com: any) => com.agent_id === agent.id);
      const myPayouts = (payouts || []).filter((p: any) => p.agent_id === agent.id);

      const leadsCount = myProspects.length;
      const leadsContratados = myProspects.filter((p: any) => p.classification === 'contratado').length;

      const totalRecurring = myCommissions
        .filter((com: any) => com.type === 'percentage')
        .reduce((sum: number, com: any) => sum + Number(com.amount), 0);

      const totalFixed = myCommissions
        .filter((com: any) => com.type === 'fixed')
        .reduce((sum: number, com: any) => sum + Number(com.amount), 0);

      const totalEarned = totalRecurring + totalFixed;

      const totalPaid = myCommissions
        .filter((com: any) => com.paid === true)
        .reduce((sum: number, com: any) => sum + Number(com.amount), 0);

      const pendingBalance = myCommissions
        .filter((com: any) => com.paid === false)
        .reduce((sum: number, com: any) => sum + Number(com.amount), 0);

      const mappedComercial = mapAgentToComercial(agent);

      return {
        ...mappedComercial,
        stats: {
          leadsCount,
          leadsContratados,
          totalRecurring,
          totalFixed,
          totalEarned,
          totalPaid,
          pendingBalance
        }
      };
    });

    res.json({ success: true, comerciales: list });
  } catch (err: any) {
    console.error('[Comerciales Admin API] Error listing comerciales:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 2. Crear un nuevo comercial
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { name, email, phone, company, pin, commission_mode, commission_value, stripe_connect_account_id, payment_method, status } = req.body;

  if (!name || !email || !pin || !commission_mode || commission_value === undefined) {
    res.status(400).json({ error: 'Nombre, email, PIN, modalidad de comisión y valor son requeridos.' });
    return;
  }

  try {
    const crypto = require('crypto');
    const access_url = crypto.randomBytes(9).toString('base64url');

    const { data, error } = await supabase
      .from('commercial_agents')
      .insert({
        name,
        email: email.trim().toLowerCase(),
        phone,
        company,
        pin: pin.trim(),
        access_url,
        commission_type: commission_mode,
        commission_value: Number(commission_value),
        stripe_account_id: stripe_connect_account_id || null,
        status: status || 'active'
      })
      .select('*')
      .single();

    if (error) {
      if (error.message.includes('unique')) {
        res.status(400).json({ error: 'El correo electrónico ya está registrado para otro comercial.' });
        return;
      }
      throw error;
    }

    res.json({ success: true, comercial: mapAgentToComercial(data) });
  } catch (err: any) {
    console.error('[Comerciales Admin API] Error creating comercial:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 3. Actualizar un comercial
 */
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const updates = req.body;

  const mappedUpdates: any = { ...updates };
  if (updates.commission_mode !== undefined) {
    mappedUpdates.commission_type = updates.commission_mode;
    delete mappedUpdates.commission_mode;
  }
  if (updates.stripe_connect_account_id !== undefined) {
    mappedUpdates.stripe_account_id = updates.stripe_connect_account_id;
    delete mappedUpdates.stripe_connect_account_id;
  }
  if (updates.payment_method !== undefined) {
    delete mappedUpdates.payment_method;
  }

  try {
    const { data, error } = await supabase
      .from('commercial_agents')
      .update(mappedUpdates)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;
    res.json({ success: true, comercial: mapAgentToComercial(data) });
  } catch (err: any) {
    console.error('[Comerciales Admin API] Error updating comercial:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 4. Eliminar un comercial
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('commercial_agents')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true, message: 'Comercial eliminado correctamente.' });
  } catch (err: any) {
    console.error('[Comerciales Admin API] Error deleting comercial:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 5. Obtener leads asignados a un comercial
 */
router.get('/:id/leads', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const { data: leads, error } = await supabase
      .from('prospects')
      .select('*')
      .eq('commercial_agent_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, leads: leads || [] });
  } catch (err: any) {
    console.error('[Comerciales Admin API] Error getting comercial leads:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 6. Obtener comisiones de un comercial
 */
router.get('/:id/commissions', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const { data: commissions, error } = await supabase
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
      .eq('agent_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;

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

    const mappedCommissions = (commissions || []).map((com: any) => {
      const tenant = tenants.find((t: any) => t.id === com.prospects?.demo_tenant_id);
      return {
        ...com,
        comercial_id: com.agent_id,
        status: com.paid ? 'paid' : 'pending',
        payout_id: com.payment_id,
        tenants: tenant ? {
          business_name: tenant.business_name,
          subscription_plan: tenant.subscription_plan,
          price_amount: tenant.price_amount
        } : null
      };
    });

    res.json({ success: true, commissions: mappedCommissions });
  } catch (err: any) {
    console.error('[Comerciales Admin API] Error getting comercial commissions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 7. Procesar pago de comisiones (Manual o Stripe Connect)
 */
router.post('/payout', async (req: Request, res: Response): Promise<void> => {
  const { comercial_id, amount, payment_method, notes } = req.body;

  if (!comercial_id || !amount || amount <= 0 || !payment_method) {
    res.status(400).json({ error: 'Comercial ID, importe y método de pago son obligatorios.' });
    return;
  }

  try {
    // 1. Obtener comercial
    const { data: agent, error: cErr } = await supabase
      .from('commercial_agents')
      .select('*')
      .eq('id', comercial_id)
      .single();

    if (cErr || !agent) {
      res.status(404).json({ error: 'Agente comercial no encontrado.' });
      return;
    }

    const comercial = mapAgentToComercial(agent);

    // 2. Obtener comisiones pendientes
    const { data: pendingCommissions, error: comErr } = await supabase
      .from('commissions')
      .select('*')
      .eq('agent_id', comercial_id)
      .eq('paid', false)
      .order('created_at', { ascending: true });

    if (comErr) throw comErr;

    const totalPending = (pendingCommissions || []).reduce((sum, com) => sum + Number(com.amount), 0);
    if (amount > totalPending + 0.01) { // 0.01 margin for float inaccuracies
      res.status(400).json({ error: `El importe a pagar (${amount}€) excede el saldo pendiente del comercial (${totalPending}€).` });
      return;
    }

    // 3. Si el método de pago es Stripe y Connect está configurado
    let stripeTransferId = '';
    if (payment_method === 'stripe') {
      if (!comercial.stripe_connect_account_id) {
        res.status(400).json({ error: 'El comercial no tiene configurada una cuenta de Stripe Connect.' });
        return;
      }

      try {
        const stripe = await getStripeClient();
        console.log(`🤖 Iniciando transferencia Stripe Connect de ${amount} EUR al comercial ${comercial.name} (cuenta: ${comercial.stripe_connect_account_id})...`);
        const transfer = await stripe.transfers.create({
          amount: Math.round(amount * 100), // en céntimos
          currency: 'eur',
          destination: comercial.stripe_connect_account_id,
          description: `Liquidación de Comisiones Receptia - Comercial: ${comercial.name}`
        });
        stripeTransferId = transfer.id;
        console.log(`✅ Transferencia de Stripe Connect exitosa: ${stripeTransferId}`);
      } catch (stripeErr: any) {
        console.error('[Stripe Connect Payout Error]:', stripeErr.message);
        res.status(400).json({ error: `Fallo en la pasarela de pagos de Stripe Connect: ${stripeErr.message}` });
        return;
      }
    }

    // 4. Crear registro en commission_payments (payouts)
    let commissionRecurringAmount = 0;
    let commissionFixedAmount = 0;

    // Calcular cuánto va para fijo y cuánto para recurrente
    let remainingPayout = amount;
    const commissionsToPay: any[] = [];
    const commissionsToUpdate: any[] = [];
    const commissionsToInsert: any[] = [];

    for (const com of pendingCommissions || []) {
      if (remainingPayout <= 0) break;
      const comAmount = Number(com.amount);

      if (remainingPayout >= comAmount) {
        commissionsToPay.push(com.id);
        remainingPayout -= comAmount;
        if (com.type === 'percentage') {
          commissionRecurringAmount += comAmount;
        } else {
          commissionFixedAmount += comAmount;
        }
      } else {
        // Payout parcial sobre esta comisión
        // Dividimos la comisión:
        // 1. Una comisión pagada para el payout actual
        commissionsToInsert.push({
          agent_id: comercial.id,
          prospect_id: com.prospect_id,
          tenant_id: com.tenant_id,
          type: com.type,
          amount: remainingPayout,
          paid: true,
          period: com.period,
          created_at: com.created_at
        });

        // 2. Actualizar la comisión original restándole el importe pagado
        commissionsToUpdate.push({
          id: com.id,
          amount: comAmount - remainingPayout
        });

        if (com.type === 'percentage') {
          commissionRecurringAmount += remainingPayout;
        } else {
          commissionFixedAmount += remainingPayout;
        }

        remainingPayout = 0;
      }
    }

    const { data: payout, error: payErr } = await supabase
      .from('commission_payments')
      .insert({
        agent_id: comercial.id,
        total_amount: amount,
        recurrent_amount: commissionRecurringAmount,
        fixed_amount: commissionFixedAmount,
        method: payment_method,
        stripe_transfer_id: stripeTransferId || null,
        status: 'completed',
        notes
      })
      .select('*')
      .single();

    if (payErr) throw payErr;

    // 5. Vincular comisiones pagadas con el payout
    if (commissionsToPay.length > 0) {
      await supabase
        .from('commissions')
        .update({ paid: true, payment_id: payout.id })
        .in('id', commissionsToPay);
    }

    if (commissionsToUpdate.length > 0) {
      for (const item of commissionsToUpdate) {
        await supabase
          .from('commissions')
          .update({ amount: item.amount })
          .eq('id', item.id);
      }
    }

    if (commissionsToInsert.length > 0) {
      const inserts = commissionsToInsert.map(item => ({ ...item, payment_id: payout.id }));
      await supabase.from('commissions').insert(inserts);
    }

    // 6. Registrar en contabilidad general (accounting_transactions)
    const concept = `Pago Comisión Comercial: ${comercial.name} ${stripeTransferId ? `(Stripe TX ${stripeTransferId})` : '(Manual)'}`;
    await supabase
      .from('accounting_transactions')
      .insert({
        type: 'expense',
        concept,
        amount,
        date: new Date().toISOString().split('T')[0]
      });

    const mappedPayout = {
      ...payout,
      comercial_id: payout.agent_id,
      amount: payout.total_amount,
      commission_recurring_amount: payout.recurrent_amount,
      commission_fixed_amount: payout.fixed_amount,
      payment_method: payout.method
    };

    res.json({ success: true, payout: mappedPayout, message: 'Pago registrado y procesado con éxito.' });
  } catch (err: any) {
    console.error('[Comerciales Admin API] Error executing payout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 8. Listar todos los payouts registrados (Historial de liquidaciones)
 */
router.get('/payouts/all', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data: payouts, error } = await supabase
      .from('commission_payments')
      .select(`
        *,
        commercial_agents (
          name,
          email
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const mappedPayouts = (payouts || []).map((p: any) => ({
      ...p,
      comercial_id: p.agent_id,
      amount: p.total_amount,
      commission_recurring_amount: p.recurrent_amount,
      commission_fixed_amount: p.fixed_amount,
      payment_method: p.method,
      comerciales: p.commercial_agents
    }));

    res.json({ success: true, payouts: mappedPayouts });
  } catch (err: any) {
    console.error('[Comerciales Admin API] Error listing payouts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 9. Sincronización Batch manual: evaluar clientes activos y generar comisiones recurrentes pendientes
 */
router.post('/run-billing-cycle', async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('[Comerciales Admin API] Iniciando ciclo batch manual de verificación de comisiones recurrentes...');
    
    // 1. Obtener prospectos contratados con comercial
    const { data: prospects } = await supabase
      .from('prospects')
      .select('*, demo_tenant_id')
      .eq('classification', 'contratado')
      .not('commercial_agent_id', 'is', null);

    if (!prospects || prospects.length === 0) {
      res.json({ success: true, count: 0, message: 'No hay prospectos contratados con comisiones asignadas.' });
      return;
    }

    const currentPeriod = new Date().toISOString().substring(0, 7); // 'YYYY-MM'
    let generatedCount = 0;

    for (const p of prospects) {
      if (!p.demo_tenant_id) continue;

      // Obtener inquilino
      const { data: tenant } = await supabase
        .from('tenants')
        .select('*')
        .eq('id', p.demo_tenant_id)
        .maybeSingle();

      // Comprobar si la suscripción está activa
      if (tenant && tenant.subscription_status === 'active') {
        // Obtener comercial
        const { data: agent } = await supabase
          .from('commercial_agents')
          .select('*')
          .eq('id', p.commercial_agent_id)
          .maybeSingle();

        const comercial = mapAgentToComercial(agent);

        if (comercial && comercial.status === 'active' && comercial.commission_mode === 'percentage') {
          // Verificar si ya existe comisión para este período
          const { data: existing } = await supabase
            .from('commissions')
            .select('id')
            .eq('agent_id', comercial.id)
            .eq('prospect_id', p.id)
            .eq('period', currentPeriod)
            .maybeSingle();

          if (!existing) {
            const price = Number(tenant.price_amount || 149.00);
            const commissionAmount = price * (comercial.commission_value / 100);

            await supabase
              .from('commissions')
              .insert({
                agent_id: comercial.id,
                prospect_id: p.id,
                tenant_id: tenant.id,
                type: 'percentage',
                amount: commissionAmount,
                paid: false,
                period: currentPeriod
              });

            generatedCount++;
          }
        }
      }
    }

    res.json({ success: true, count: generatedCount, message: `Se generaron ${generatedCount} comisiones recurrentes para el período ${currentPeriod}.` });
  } catch (err: any) {
    console.error('[Comerciales Admin API] Error running billing cycle:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
