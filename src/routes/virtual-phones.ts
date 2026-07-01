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
 * 2. Agregar un nuevo número de teléfono virtual
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { phone_number, next_billing_date, tenant_id, prospect_id, sip_username, sip_password, sip_server } = req.body;

  if (!phone_number) {
    res.status(400).json({ error: 'El número de teléfono es obligatorio.' });
    return;
  }

  try {
    const status = (tenant_id || prospect_id) ? 'assigned' : 'available';

    const { data, error } = await supabase
      .from('virtual_phones')
      .insert([{
        phone_number: phone_number.trim(),
        next_billing_date: next_billing_date || null,
        tenant_id: tenant_id || null,
        prospect_id: prospect_id || null,
        sip_username: sip_username || null,
        sip_password: sip_password || null,
        sip_server: sip_server || null,
        status
      }])
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (error: any) {
    console.error('[Virtual Phones API] Error al crear teléfono virtual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 3. Actualizar un teléfono virtual (asignación, fecha de vencimiento, etc.)
 */
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { phone_number, next_billing_date, tenant_id, prospect_id, sip_username, sip_password, sip_server } = req.body;

  try {
    // Si se pasa tenant_id o prospect_id vacíos/limpios, se desasigna.
    const cleanTenantId = tenant_id === 'clear' || !tenant_id ? null : tenant_id;
    const cleanProspectId = prospect_id === 'clear' || !prospect_id ? null : prospect_id;

    const status = (cleanTenantId || cleanProspectId) ? 'assigned' : 'available';

    const { data, error } = await supabase
      .from('virtual_phones')
      .update({
        phone_number: phone_number !== undefined ? phone_number.trim() : undefined,
        next_billing_date: next_billing_date !== undefined ? (next_billing_date || null) : undefined,
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

    if (error) throw error;

    res.json({ success: true, data });
  } catch (error: any) {
    console.error('[Virtual Phones API] Error al actualizar teléfono virtual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 4. Eliminar un teléfono virtual del catálogo
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('virtual_phones')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true, message: 'Teléfono virtual eliminado con éxito.' });
  } catch (error: any) {
    console.error('[Virtual Phones API] Error al eliminar teléfono virtual:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
