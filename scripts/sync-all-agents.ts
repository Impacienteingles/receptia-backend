import * as dotenv from 'dotenv';
import { syncTenantWithRetell } from '../src/services/retell';
import { supabase } from '../src/services/supabase';

dotenv.config();

async function main() {
  console.log('🏁 Iniciando resincronización de todos los agentes de Retell...');

  // 1. Obtener todos los inquilinos
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('*');

  if (error) {
    console.error('❌ Error al obtener inquilinos de Supabase:', error.message);
    process.exit(1);
  }

  if (!tenants || tenants.length === 0) {
    console.log('ℹ️ No hay inquilinos registrados.');
    process.exit(0);
  }

  console.log(`🔍 Se encontraron ${tenants.length} inquilinos.`);

  let webhookBaseUrl = 'https://corandar.onrender.com';

  for (const tenant of tenants) {
    if (!tenant.retell_agent_id) {
      console.log(`⚠️ Tenant ${tenant.email} no tiene un retell_agent_id configurado. Saltando...`);
      continue;
    }

    try {
      console.log(`⚙️ Sincronizando agente ${tenant.retell_agent_id} para ${tenant.email}...`);
      await syncTenantWithRetell(tenant, webhookBaseUrl);
      console.log(`✅ Agente ${tenant.retell_agent_id} sincronizado exitosamente.`);
    } catch (err: any) {
      console.error(`❌ Error al sincronizar ${tenant.email}:`, err.message);
    }
  }

  console.log('🎉 Resincronización completada de todos los inquilinos.');
  process.exit(0);
}

main();
