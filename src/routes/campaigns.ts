import { Router, Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { triggerOutboundCall } from '../services/retell';

const router = Router();

/**
 * GET /api/campaigns
 * Obtiene todas las campañas de un tenant con estadísticas agregadas.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const { tenant_id } = req.query;

  if (!tenant_id) {
    res.status(400).json({ error: 'El parámetro tenant_id es obligatorio.' });
    return;
  }

  try {
    const { data: campaigns, error: cErr } = await supabase
      .from('outbound_campaigns')
      .select('*')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: false });

    if (cErr) throw cErr;

    const campaignsWithStats = await Promise.all(
      (campaigns || []).map(async (c: any) => {
        const { data: recipients, error: rErr } = await supabase
          .from('outbound_campaign_recipients')
          .select('status')
          .eq('campaign_id', c.id);

        const stats = {
          total: 0,
          pending: 0,
          calling: 0,
          completed: 0,
          failed: 0,
          no_answer: 0,
          completed_with_booking: 0
        };

        if (!rErr && recipients) {
          stats.total = recipients.length;
          recipients.forEach((r: any) => {
            if (r.status === 'pending') stats.pending++;
            else if (r.status === 'calling') stats.calling++;
            else if (r.status === 'completed') stats.completed++;
            else if (r.status === 'failed') stats.failed++;
            else if (r.status === 'no_answer') stats.no_answer++;
            else if (r.status === 'completed_with_booking') stats.completed_with_booking++;
          });
        }

        return { ...c, stats };
      })
    );

    res.json(campaignsWithStats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/campaigns/:campaign_id
 * Obtiene el detalle de una campaña específica y sus destinatarios.
 */
router.get('/:campaign_id', async (req: Request, res: Response): Promise<void> => {
  const { campaign_id } = req.params;

  try {
    const { data: campaign, error: cErr } = await supabase
      .from('outbound_campaigns')
      .select('*')
      .eq('id', campaign_id)
      .single();

    if (cErr || !campaign) {
      res.status(404).json({ error: 'Campaña no encontrada.' });
      return;
    }

    const { data: recipients, error: rErr } = await supabase
      .from('outbound_campaign_recipients')
      .select('*')
      .eq('campaign_id', campaign_id)
      .order('created_at', { ascending: true });

    res.json({
      campaign,
      recipients: recipients || []
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/campaigns
 * Crea una nueva campaña y añade la lista de recipientes.
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { tenant_id, name, recipients } = req.body;

  if (!tenant_id || !name || !recipients || !Array.isArray(recipients)) {
    res.status(400).json({ error: 'Parámetros obligatorios faltantes o inválidos (tenant_id, name, recipients).' });
    return;
  }

  try {
    // 1. Insertar cabecera de campaña
    const { data: campaign, error: cErr } = await supabase
      .from('outbound_campaigns')
      .insert({
        tenant_id,
        name,
        status: 'pending'
      })
      .select()
      .single();

    if (cErr || !campaign) throw cErr;

    // 2. Insertar destinatarios
    const recipientsData = recipients.map((r: any) => ({
      campaign_id: campaign.id,
      client_name: r.client_name,
      client_phone: r.client_phone,
      custom_variable: r.custom_variable || null,
      status: 'pending'
    }));

    const { error: rErr } = await supabase
      .from('outbound_campaign_recipients')
      .insert(recipientsData);

    if (rErr) throw rErr;

    res.json({
      success: true,
      campaign_id: campaign.id,
      name: campaign.name
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/campaigns/:campaign_id/launch
 * Dispara de forma asíncrona la ejecución de llamadas salientes para la campaña.
 */
router.post('/:campaign_id/launch', async (req: Request, res: Response): Promise<void> => {
  const { campaign_id } = req.params;

  try {
    // 1. Obtener la campaña y sus destinatarios pendientes
    const { data: campaign, error: cErr } = await supabase
      .from('outbound_campaigns')
      .select('*, tenants(*)')
      .eq('id', campaign_id)
      .single();

    if (cErr || !campaign) {
      res.status(404).json({ error: 'Campaña no encontrada.' });
      return;
    }

    if (campaign.status === 'running') {
      res.status(400).json({ error: 'La campaña ya está en ejecución.' });
      return;
    }

    const { data: recipients, error: rErr } = await supabase
      .from('outbound_campaign_recipients')
      .select('*')
      .eq('campaign_id', campaign_id)
      .eq('status', 'pending');

    if (rErr || !recipients || recipients.length === 0) {
      res.status(400).json({ error: 'No hay destinatarios pendientes para lanzar esta campaña.' });
      return;
    }

    // 2. Validar que el tenant tenga agente de Retell activo
    const tenant = campaign.tenants;
    const agentId = tenant?.retell_agent_id;
    if (!agentId) {
      res.status(400).json({ error: 'El inquilino no tiene un agente de Retell AI activo configurado.' });
      return;
    }

    // 3. Actualizar estado de la campaña a 'running'
    await supabase
      .from('outbound_campaigns')
      .update({ status: 'running' })
      .eq('id', campaign_id);

    res.json({
      success: true,
      message: `Campaña '${campaign.name}' iniciada. Procesando ${recipients.length} llamadas en segundo plano de forma persistente.`,
      total_calls: recipients.length
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
