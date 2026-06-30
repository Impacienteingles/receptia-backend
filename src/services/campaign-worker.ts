import { supabase } from './supabase';
import { triggerOutboundCall } from './retell';

let workerInterval: NodeJS.Timeout | null = null;
let isProcessing = false;

/**
 * Arranca el worker de cola persistente para campañas salientes.
 * Se ejecuta periódicamente (cada 15 segundos) buscando campañas en estado 'running'.
 * Si encuentra pendientes, dispara una sola llamada en este tick y se pausa hasta el siguiente.
 * Si no quedan pendientes ni en curso, marca la campaña como 'completed'.
 */
export function startCampaignWorker() {
  if (workerInterval) return;

  console.log('[Campaign Worker] 🚀 Servicio de cola de campañas salientes inicializado.');

  workerInterval = setInterval(async () => {
    if (isProcessing) return;
    isProcessing = true;

    try {
      // 1. Obtener todas las campañas activas (running)
      const { data: runningCampaigns, error: cErr } = await supabase
        .from('outbound_campaigns')
        .select('*, tenants(*)')
        .eq('status', 'running');

      if (cErr) {
        console.error('[Campaign Worker] Error al buscar campañas activas:', cErr.message);
        isProcessing = false;
        return;
      }

      if (!runningCampaigns || runningCampaigns.length === 0) {
        isProcessing = false;
        return;
      }

      for (const campaign of runningCampaigns) {
        // 2. Buscar el siguiente destinatario pendiente para esta campaña
        const { data: nextRecipient, error: rErr } = await supabase
          .from('outbound_campaign_recipients')
          .select('*')
          .eq('campaign_id', campaign.id)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();

        if (rErr) {
          console.error(`[Campaign Worker] Error al obtener destinatario para campaña ${campaign.id}:`, rErr.message);
          continue;
        }

        if (nextRecipient) {
          const tenant = campaign.tenants;
          const agentId = tenant?.retell_agent_id;
          const fromNumber = tenant?.phone_number || process.env.RETELL_FROM_NUMBER || '+34910000000';

          if (!agentId) {
            console.error(`[Campaign Worker] Error: El tenant ${campaign.tenant_id} no tiene retell_agent_id.`);
            // Marcar destinatario como fallido
            await supabase
              .from('outbound_campaign_recipients')
              .update({ status: 'failed' })
              .eq('id', nextRecipient.id);
            continue;
          }

          // Bloquear recipiente cambiando estado a 'calling'
          await supabase
            .from('outbound_campaign_recipients')
            .update({ status: 'calling' })
            .eq('id', nextRecipient.id);

          console.log(`[Campaign Worker] 📞 Iniciando llamada para: ${nextRecipient.client_name} (${nextRecipient.client_phone}) - Campaña: ${campaign.name}`);

          try {
            const dynamicVars = {
              patient_name: nextRecipient.client_name,
              custom_note: nextRecipient.custom_variable || 'limpieza dental'
            };

            // Disparar llamada en Retell AI
            const callId = await triggerOutboundCall(
              fromNumber,
              nextRecipient.client_phone,
              agentId,
              dynamicVars
            );

            // Guardar callId
            await supabase
              .from('outbound_campaign_recipients')
              .update({ call_id: callId })
              .eq('id', nextRecipient.id);

          } catch (callErr: any) {
            console.error(`[Campaign Worker ERROR] Error al disparar llamada de Retell para ${nextRecipient.client_name}:`, callErr.message);
            await supabase
              .from('outbound_campaign_recipients')
              .update({ status: 'failed' })
              .eq('id', nextRecipient.id);
          }
        } else {
          // No hay destinatarios 'pending'. Verificar si hay llamadas 'calling' activas (en curso)
          const { count, error: countErr } = await supabase
            .from('outbound_campaign_recipients')
            .select('*', { count: 'exact', head: true })
            .eq('campaign_id', campaign.id)
            .eq('status', 'calling');

          if (!countErr && (count === null || count === 0)) {
            // Completar campaña
            await supabase
              .from('outbound_campaigns')
              .update({ status: 'completed' })
              .eq('id', campaign.id);

            console.log(`[Campaign Worker] ✅ Campaña '${campaign.name}' completada con éxito.`);
          }
        }
      }
    } catch (err: any) {
      console.error('[Campaign Worker Exception]', err.message);
    } finally {
      isProcessing = false;
    }
  }, 15000); // Frecuencia de 15 segundos (Throttle)
}
