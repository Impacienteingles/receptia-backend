import { supabase, getSettingVal } from '../src/services/supabase';
import { syncTenantWithRetell } from '../src/services/retell';

async function syncAllAgents() {
  console.log('🔄 Iniciando sincronización masiva de todos los agentes en Retell...');
  
  // Obtener la URL base del webhook
  let webhookBaseUrl = await getSettingVal('WEBHOOK_BASE_URL');
  if (!webhookBaseUrl) {
    webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
  }
  
  // Si detectamos localhost o no está definido, forzamos a producción para que Retell lo acepte
  if (!webhookBaseUrl || webhookBaseUrl.includes('localhost') || webhookBaseUrl.includes('127.0.0.1')) {
    console.log('⚠️ Detectada URL local o vacía. Usando URL de producción para Retell: https://corandar.onrender.com');
    webhookBaseUrl = 'https://corandar.onrender.com';
  }
  
  console.log(`🌍 URL Base del Webhook para Retell: ${webhookBaseUrl}`);
  
  // Obtener todos los tenants que tienen un retell_agent_id
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('*')
    .not('retell_agent_id', 'is', null);
    
  if (error) {
    console.error('❌ Error al obtener inquilinos de Supabase:', error.message);
    process.exit(1);
  }
  
  const activeTenants = tenants.filter(t => t.retell_agent_id && t.retell_agent_id.trim() !== '' && t.retell_agent_id !== 'YOUR_RETELL_AGENT_ID');
  
  console.log(`📋 Se encontraron ${activeTenants.length} inquilinos con agentes activos de Retell.`);
  
  for (const tenant of activeTenants) {
    try {
      await syncTenantWithRetell(tenant, webhookBaseUrl);
      console.log(`✅ Agente sincronizado exitosamente para: ${tenant.business_name} (${tenant.email})`);
    } catch (err: any) {
      console.error(`❌ Error al sincronizar agente para ${tenant.business_name}:`, err.message);
    }
  }
  
  console.log('\n✨ Sincronización masiva de agentes completada.');
  process.exit(0);
}

syncAllAgents();
