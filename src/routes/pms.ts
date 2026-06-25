import { Router, Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { randomUUID } from 'crypto';

const router = Router();

/**
 * POST /api/integrations/pms/sync
 * Endpoint para que el agente PMS local sincronice datos de disponibilidad o citas.
 */
router.post('/sync', async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Falta cabecera de autorización Bearer Token válida.' });
    return;
  }

  const token = authHeader.substring(7).trim();
  const { appointments, slots, database_type } = req.body;

  try {
    // Buscar inquilino por token
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('id, business_name')
      .eq('pms_sync_token', token)
      .maybeSingle();

    if (tenantErr || !tenant) {
      res.status(403).json({ error: 'Token de sincronización PMS inválido o no autorizado.' });
      return;
    }

    const now = new Date().toISOString();

    // Actualizar metadata de sincronización en el inquilino
    await supabase
      .from('tenants')
      .update({
        pms_last_sync: now,
        pms_database_type: database_type || 'other'
      })
      .eq('id', tenant.id);

    console.log(`[PMS Sync] 🔄 Sincronización recibida para ${tenant.business_name}. Tipo: ${database_type || 'other'}`);

    // Si hay citas provistas por el PMS local, sincronizarlas en Supabase
    if (appointments && Array.isArray(appointments)) {
      for (const app of appointments) {
        // En una sincronización real de base de datos, guardaríamos o actualizaríamos en la tabla appointments
        // Aquí insertamos o actualizamos para reflejar la sincronización de agenda
        const { error: appErr } = await supabase
          .from('appointments')
          .upsert({
            tenant_id: tenant.id,
            patient_name: app.patient_name || 'Paciente Sincronizado',
            patient_phone: app.patient_phone || '+34600000000',
            patient_email: app.patient_email || 'sincronizado@pms.local',
            date_time: app.date_time,
            specialty: app.specialty || 'General',
            status: app.status || 'confirmed'
          }, { onConflict: 'tenant_id, date_time, patient_phone' });
        
        if (appErr) {
          console.warn(`[PMS Sync Warning] Error al guardar cita sincronizada:`, appErr.message);
        }
      }
    }

    res.json({
      success: true,
      message: 'Sincronización de PMS local procesada correctamente.',
      last_sync: now,
      business_name: tenant.business_name
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/integrations/pms/config
 * Endpoint del panel de control para generar/actualizar el token y tipo de PMS.
 */
router.post('/config', async (req: Request, res: Response): Promise<void> => {
  const { tenant_id, database_type, reset_token } = req.body;

  if (!tenant_id) {
    res.status(400).json({ error: 'El parámetro tenant_id es obligatorio.' });
    return;
  }

  try {
    const updateData: any = {};
    if (database_type !== undefined) {
      updateData.pms_database_type = database_type;
    }
    if (reset_token) {
      updateData.pms_sync_token = 'pms_' + randomUUID().replace(/-/g, '');
    }

    const { data: updated, error } = await supabase
      .from('tenants')
      .update(updateData)
      .eq('id', tenant_id)
      .select('id, pms_sync_token, pms_database_type, pms_last_sync')
      .single();

    if (error) throw error;

    res.json({
      success: true,
      config: updated
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
