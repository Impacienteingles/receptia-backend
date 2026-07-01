import { Router, Request, Response } from 'express';
import { supabase } from '../services/supabase';

const router = Router();

/**
 * 1. Obtener todos los teléfonos virtuales con datos de clientes/prospectos asignados
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('virtual_phones')
      .select(`
        *,
        tenants:tenant_id (
          id,
          business_name
        ),
        prospects:prospect_id (
          id,
          business_name
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, data });
  } catch (error: any) {
    console.error('[Virtual Phones API] Error al obtener teléfonos virtuales:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 2. Agregar un nuevo número de teléfono virtual con cálculo automático de fecha de baja
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { phone_number, tenant_id, prospect_id, sip_username, sip_password, sip_server } = req.body;

  if (!phone_number) {
    res.status(400).json({ error: 'El número de teléfono es obligatorio.' });
    return;
  }

  try {
    let next_billing_date = null;
    const cleanTenantId = tenant_id === 'clear' || !tenant_id ? null : tenant_id;
    const cleanProspectId = prospect_id === 'clear' || !prospect_id ? null : prospect_id;
    const status = (cleanTenantId || cleanProspectId) ? 'assigned' : 'available';

    // Calcular la fecha de baja si está asignado a un cliente (tenant)
    if (cleanTenantId) {
      const { data: tenant, error: tenantErr } = await supabase
        .from('tenants')
        .select('subscription_status, trial_ends_at, contract_end_date')
        .eq('id', cleanTenantId)
        .maybeSingle();

      if (tenantErr) throw tenantErr;
      if (tenant) {
        next_billing_date = tenant.subscription_status === 'trial' 
          ? tenant.trial_ends_at 
          : tenant.contract_end_date;
      }
    }

    // Insertar el teléfono virtual con la fecha calculada
    const { data: vp, error: insertErr } = await supabase
      .from('virtual_phones')
      .insert([{
        phone_number: phone_number.trim(),
        next_billing_date,
        tenant_id: cleanTenantId,
        prospect_id: cleanProspectId,
        sip_username: sip_username || null,
        sip_password: sip_password || null,
        sip_server: sip_server || null,
        status
      }])
      .select()
      .single();

    if (insertErr) throw insertErr;

    // Si se asignó a un tenant, actualizar el registro del tenant con los datos del teléfono y SIP
    if (cleanTenantId && vp) {
      const { error: tenantUpdErr } = await supabase
        .from('tenants')
        .update({
          virtual_phone_id: vp.id,
          phone_number: vp.phone_number,
          phone_provider: 'zadarma',
          sip_username: vp.sip_username,
          sip_password: vp.sip_password,
          sip_server: vp.sip_server
        })
        .eq('id', cleanTenantId);

      if (tenantUpdErr) {
        console.error('[Virtual Phones API] Error al actualizar tenant tras asignación:', tenantUpdErr.message);
      }
    }

    res.json({ success: true, data: vp });
  } catch (error: any) {
    console.error('[Virtual Phones API] Error al crear teléfono virtual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 3. Actualizar un teléfono virtual (con cálculo de fecha de baja y sincronización bidireccional)
 */
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { phone_number, tenant_id, prospect_id, sip_username, sip_password, sip_server } = req.body;

  try {
    // Obtener el estado actual del teléfono virtual antes de actualizar
    const { data: oldVp, error: fetchOldErr } = await supabase
      .from('virtual_phones')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchOldErr) throw fetchOldErr;
    if (!oldVp) {
      res.status(404).json({ error: 'No se encontró el teléfono virtual.' });
      return;
    }

    const cleanTenantId = tenant_id === 'clear' || !tenant_id ? null : tenant_id;
    const cleanProspectId = prospect_id === 'clear' || !prospect_id ? null : prospect_id;
    const status = (cleanTenantId || cleanProspectId) ? 'assigned' : 'available';

    // Calcular la fecha de baja si hay tenant asignado
    let next_billing_date = null;
    if (cleanTenantId) {
      const { data: tenant, error: tenantErr } = await supabase
        .from('tenants')
        .select('subscription_status, trial_ends_at, contract_end_date')
        .eq('id', cleanTenantId)
        .maybeSingle();

      if (tenantErr) throw tenantErr;
      if (tenant) {
        next_billing_date = tenant.subscription_status === 'trial' 
          ? tenant.trial_ends_at 
          : tenant.contract_end_date;
      }
    }

    // Actualizar el teléfono virtual
    const { data: vp, error: updateErr } = await supabase
      .from('virtual_phones')
      .update({
        phone_number: phone_number !== undefined ? phone_number.trim() : undefined,
        next_billing_date,
        tenant_id: cleanTenantId,
        prospect_id: cleanProspectId,
        sip_username: sip_username !== undefined ? (sip_username || null) : undefined,
        sip_password: sip_password !== undefined ? (sip_password || null) : undefined,
        sip_server: sip_server !== undefined ? (sip_server || null) : undefined,
        status
      })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    // Sincronización en tabla tenants:
    // A. Si se cambió o removió el tenant anterior, limpiar su configuración
    if (oldVp.tenant_id && oldVp.tenant_id !== cleanTenantId) {
      const { error: oldTenantErr } = await supabase
        .from('tenants')
        .update({
          virtual_phone_id: null,
          phone_number: null,
          phone_provider: 'retell',
          sip_username: null,
          sip_password: null,
          sip_server: null
        })
        .eq('id', oldVp.tenant_id);

      if (oldTenantErr) {
        console.error('[Virtual Phones API] Error al desasignar inquilino anterior:', oldTenantErr.message);
      }
    }

    // B. Actualizar el nuevo tenant asignado con la información del teléfono y SIP
    if (cleanTenantId && vp) {
      const { error: newTenantErr } = await supabase
        .from('tenants')
        .update({
          virtual_phone_id: vp.id,
          phone_number: vp.phone_number,
          phone_provider: 'zadarma',
          sip_username: vp.sip_username,
          sip_password: vp.sip_password,
          sip_server: vp.sip_server
        })
        .eq('id', cleanTenantId);

      if (newTenantErr) {
        console.error('[Virtual Phones API] Error al actualizar nuevo inquilino asignado:', newTenantErr.message);
      }
    }

    res.json({ success: true, data: vp });
  } catch (error: any) {
    console.error('[Virtual Phones API] Error al actualizar teléfono virtual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 4. Eliminar un teléfono virtual y limpiar las referencias en tenants
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    // Obtener el tenant_id asignado antes de eliminar
    const { data: vp, error: fetchErr } = await supabase
      .from('virtual_phones')
      .select('tenant_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;

    // Eliminar el teléfono virtual
    const { error: deleteErr } = await supabase
      .from('virtual_phones')
      .delete()
      .eq('id', id);

    if (deleteErr) throw deleteErr;

    // Si tenía un tenant asignado, limpiar su configuración de teléfono Zadarma
    if (vp && vp.tenant_id) {
      const { error: tenantClearErr } = await supabase
        .from('tenants')
        .update({
          virtual_phone_id: null,
          phone_number: null,
          phone_provider: 'retell',
          sip_username: null,
          sip_password: null,
          sip_server: null
        })
        .eq('id', vp.tenant_id);

      if (tenantClearErr) {
        console.error('[Virtual Phones API] Error al limpiar tenant tras eliminar teléfono:', tenantClearErr.message);
      }
    }

    res.json({ success: true, message: 'Teléfono virtual eliminado con éxito y referencias limpiadas.' });
  } catch (error: any) {
    console.error('[Virtual Phones API] Error al eliminar teléfono virtual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
