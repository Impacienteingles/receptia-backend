import { Router, Request, Response } from 'express';
import { supabase, getSettingVal } from '../services/supabase';
import axios from 'axios';

const router = Router();

// GET /api/admin/email-marketing/contacts - Obtener contactos (prospectos y clientes activos)
router.get('/contacts', async (req: Request, res: Response): Promise<void> => {
  try {
    // 1. Obtener prospectos
    const { data: prospects, error: pErr } = await supabase
      .from('prospects')
      .select('id, business_name, email, phone')
      .order('created_at', { ascending: false });

    if (pErr) throw pErr;

    // 2. Obtener clientes activos (inquilinos)
    const { data: clients, error: cErr } = await supabase
      .from('tenants')
      .select('id, business_name, email, phone_number')
      .order('created_at', { ascending: false });

    if (cErr) throw cErr;

    const formattedClients = (clients || []).map((c: any) => ({
      id: c.id,
      business_name: c.business_name,
      email: c.email,
      phone: c.phone_number
    }));

    res.json({
      prospects: prospects || [],
      clients: formattedClients
    });
  } catch (err: any) {
    console.error('[Email Marketing Contacts] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/email-marketing/campaigns - Obtener todas las campañas con analíticas
router.get('/campaigns', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data: campaigns, error: cErr } = await supabase
      .from('email_campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    if (cErr) throw cErr;

    const campaignsWithStats = await Promise.all(
      (campaigns || []).map(async (c: any) => {
        const { data: recipients, error: rErr } = await supabase
          .from('email_campaign_recipients')
          .select('status')
          .eq('campaign_id', c.id);

        const stats = {
          total: 0,
          sent: 0,
          opened: 0,
          clicked: 0,
          converted: 0,
          openRate: 0,
          clickRate: 0,
          conversionRate: 0
        };

        if (!rErr && recipients) {
          stats.total = recipients.length;
          recipients.forEach((r: any) => {
            if (r.status === 'sent') stats.sent++;
            else if (r.status === 'opened') stats.opened++;
            else if (r.status === 'clicked') stats.clicked++;
            else if (r.status === 'converted') stats.converted++;
          });

          // Abiertos acumulados = opened + clicked + converted (ya que para hacer click o convertir debieron abrirlo)
          const totalOpened = stats.opened + stats.clicked + stats.converted;
          // Clics acumulados = clicked + converted
          const totalClicked = stats.clicked + stats.converted;

          stats.openRate = stats.total > 0 ? Math.round((totalOpened / stats.total) * 100) : 0;
          stats.clickRate = stats.total > 0 ? Math.round((totalClicked / stats.total) * 100) : 0;
          stats.conversionRate = stats.total > 0 ? Math.round((stats.converted / stats.total) * 100) : 0;
        }

        return { ...c, stats };
      })
    );

    res.json(campaignsWithStats);
  } catch (err: any) {
    console.error('[Email Marketing Campaigns List] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/email-marketing/campaigns - Crear y enviar campaña
router.post('/campaigns', async (req: Request, res: Response): Promise<void> => {
  const { name, subject, template_id, body_content, recipients } = req.body;

  if (!name || !subject || !template_id || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
    res.status(400).json({ error: 'Faltan campos obligatorios o la lista de destinatarios está vacía.' });
    return;
  }

  try {
    const resendApiKey = await getSettingVal('RESEND_API_KEY') || process.env.RESEND_API_KEY;
    const resendFrom = await getSettingVal('RESEND_FROM_EMAIL') || process.env.RESEND_FROM_EMAIL || 'Receptia Marketing <onboarding@resend.dev>';

    if (!resendApiKey || resendApiKey === 'YOUR_RESEND_API_KEY') {
      res.status(400).json({ error: 'Por favor, configura la clave de Resend (RESEND_API_KEY) en los Ajustes del administrador.' });
      return;
    }

    // 1. Guardar la campaña en la base de datos
    const { data: campaign, error: cErr } = await supabase
      .from('email_campaigns')
      .insert({
        name,
        subject,
        template_id,
        body_content,
        status: 'sending'
      })
      .select()
      .single();

    if (cErr || !campaign) throw cErr || new Error('No se pudo guardar la campaña.');

    // Obtener host para la URL de tracking
    const host = req.get('host') || '';
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? req.protocol : 'https';
    const baseUrl = `${protocol}://${host}`;

    // Obtener lista de emails desuscritos
    const { data: unsubscribedRecords } = await supabase
      .from('email_unsubscribes')
      .select('email');

    const unsubscribedEmails = new Set(
      (unsubscribedRecords || []).map((u: any) => u.email.trim().toLowerCase())
    );

    // 2. Procesar destinatarios
    let sentCount = 0;
    let failedCount = 0;

    for (const r of recipients) {
      if (!r.email) continue;
      const cleanEmail = r.email.trim().toLowerCase();
      const isUnsubscribed = unsubscribedEmails.has(cleanEmail);

      try {
        // Guardar destinatario en la base de datos
        const { data: recipientRecord, error: rErr } = await supabase
          .from('email_campaign_recipients')
          .insert({
            campaign_id: campaign.id,
            email: cleanEmail,
            name: r.name || null,
            recipient_type: r.type || 'manual',
            status: isUnsubscribed ? 'unsubscribed' : 'sent'
          })
          .select()
          .single();

        if (rErr || !recipientRecord) {
          console.error(`[Email Marketing] Error al insertar destinatario ${r.email}:`, rErr);
          failedCount++;
          continue;
        }

        // Si está desuscrito, no enviamos y pasamos al siguiente
        if (isUnsubscribed) {
          console.log(`[Email Marketing] Omitiendo envío a dirección desuscrita: ${cleanEmail}`);
          continue;
        }

        // Reemplazar marcadores en el cuerpo
        let dynamicBody = (body_content || '')
          .replace(/{{name}}/g, r.name || 'Cliente')
          .replace(/{{business_name}}/g, r.name || 'Negocio');

        // Construir contenido final usando la plantilla seleccionada
        const finalHtml = buildHtmlFromTemplate(template_id, subject, dynamicBody, recipientRecord.id, baseUrl);

        // Enviar a través de la API de Resend
        await axios.post('https://api.resend.com/emails', {
          from: resendFrom,
          to: r.email.trim(),
          subject: subject,
          html: finalHtml
        }, {
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          }
        });

        sentCount++;
      } catch (sendErr: any) {
        console.error(`[Email Marketing] Error al enviar correo a ${r.email}:`, sendErr.response?.data || sendErr.message);
        failedCount++;
      }
    }

    // Actualizar estado de la campaña
    await supabase
      .from('email_campaigns')
      .update({
        status: failedCount === recipients.length ? 'failed' : 'completed'
      })
      .eq('id', campaign.id);

    res.json({
      success: true,
      campaign_id: campaign.id,
      sent: sentCount,
      failed: failedCount
    });
  } catch (err: any) {
    console.error('[Email Marketing Dispatch] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/email-marketing/campaigns - Eliminar una o varias campañas
router.delete('/campaigns', async (req: Request, res: Response): Promise<void> => {
  const { ids } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'Debes proporcionar un array de IDs de campañas a eliminar.' });
    return;
  }

  try {
    const { error } = await supabase
      .from('email_campaigns')
      .delete()
      .in('id', ids);

    if (error) throw error;

    res.json({ success: true, deletedCount: ids.length });
  } catch (err: any) {
    console.error('[Email Marketing Campaigns Delete] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// Función auxiliar para renderizar la plantilla HTML seleccionada
function buildHtmlFromTemplate(templateId: string, subject: string, bodyText: string, recipientId: string, baseUrl: string): string {
  // Enlaces de tracking
  const trackOpenUrl = `${baseUrl}/api/public/email-campaigns/track-open/${recipientId}`;
  const trackClickBaseUrl = `${baseUrl}/api/public/email-campaigns/track-click/${recipientId}`;

  // Reemplazar los enlaces comunes en el texto por la URL de tracking
  const rewriteLink = (url: string) => `${trackClickBaseUrl}?redirect=${encodeURIComponent(url)}`;

  // Un formateador básico de párrafos para que los saltos de línea se vean bien en HTML
  const formattedBody = bodyText
    .split('\n')
    .map(p => p.trim() ? `<p style="margin: 0 0 1rem 0; line-height: 1.6; color: #374151;">${p}</p>` : '')
    .join('');

  // Diseños de plantillas HTML responsivas y profesionales
  let contentHtml = '';

  if (templateId === 'corandar_elegant') {
    // 1. Plantilla Corandar Elegant (Fondo blanco, logos con esquinas redondeadas)
    contentHtml = `
      <div style="background-color: #f3f4f6; padding: 2rem 1rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03); border: 1px solid #e5e7eb;">
          
          <!-- Header con logos en horizontal -->
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #ffffff; border-bottom: 1px solid #f3f4f6; width: 100%;">
            <tr>
              <td align="left" style="padding: 1.25rem 2rem; vertical-align: middle;">
                <img src="https://receptia.corandar.com/logo.png" alt="Receptia AI" style="height: 28px; max-width: 120px; display: block; border: 0; outline: none; object-fit: contain;">
              </td>
              <td align="right" style="padding: 1.25rem 2rem; vertical-align: middle;">
                <img src="https://receptia.corandar.com/corandar-logo.png" alt="Corandar" style="height: 22px; max-width: 120px; display: block; border: 0; outline: none; object-fit: contain;">
              </td>
            </tr>
          </table>

          <!-- Cuerpo -->
          <div style="padding: 2.5rem 2rem;">
            <h1 style="margin: 0 0 1.5rem 0; font-size: 1.5rem; font-weight: 700; color: #111827; text-align: left;">${subject}</h1>
            <div style="font-size: 1rem; color: #374151;">
              ${formattedBody}
            </div>
            
            <!-- Botón CTA principal de Corandar -->
            <div style="margin-top: 2.5rem; text-align: center;">
              <a href="${rewriteLink('https://receptia.corandar.com')}" style="background-color: #111827; color: #ffffff; padding: 0.8rem 2rem; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.95rem; display: inline-block; transition: background-color 0.2s; box-shadow: 0 4px 6px rgba(0,0,0,0.08);">
                Comenzar Ahora
              </a>
            </div>
          </div>

          <!-- Footer con Logos de Receptia y Corandar -->
          <div style="background-color: #fafafa; padding: 2rem; border-top: 1px solid #f3f4f6; text-align: center;">
            <div style="display: flex; justify-content: center; align-items: center; gap: 1rem; margin-bottom: 1.5rem;">
              <!-- Mini logo de Corandar -->
              <div style="background-color: #ffffff; padding: 0.35rem 0.65rem; border-radius: 6px; border: 1px solid #e5e7eb; display: inline-block;">
                <span style="font-weight: 800; font-size: 0.75rem; color: #111827;">Corandar</span>
              </div>
              <span style="color: #d1d5db; font-size: 0.9rem;">+</span>
              <!-- Mini logo de Receptia -->
              <div style="background-color: #7c3aed; padding: 0.35rem 0.65rem; border-radius: 6px; display: inline-block;">
                <span style="font-weight: 800; font-size: 0.75rem; color: #ffffff;">Receptia AI</span>
              </div>
            </div>
            <p style="margin: 0; font-size: 0.8rem; color: #9ca3af; line-height: 1.5;">Este mensaje fue enviado por el sistema de marketing inteligente de Corandar.<br>© 2026 Corandar S.L. Todos los derechos reservados.<br><span style="font-size: 0.75rem; color: #9ca3af;">Si no deseas recibir más correos de este tipo, puedes desuscribirte haciendo clic <a href="${baseUrl}/api/public/email-campaigns/unsubscribe/${recipientId}" target="_blank" style="color: #6b7280; text-decoration: underline;">aquí</a>.</span></p>
          </div>

        </div>
      </div>
    `;
  } else if (templateId === 'receptia_launch') {
    // 2. Plantilla Receptia Launch (Diseño tecnológico, logo de Receptia)
    contentHtml = `
      <div style="background-color: #0b0f19; padding: 2rem 1rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #111827; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.3); border: 1px solid #1f2937;">
          
          <!-- Header con logos en horizontal -->
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #ffffff; border-bottom: 1px solid #e5e7eb; width: 100%;">
            <tr>
              <td align="left" style="padding: 1rem 1.5rem; vertical-align: middle;">
                <img src="https://receptia.corandar.com/logo.png" alt="Receptia AI" style="height: 28px; max-width: 120px; display: block; border: 0; outline: none; object-fit: contain;">
              </td>
              <td align="right" style="padding: 1rem 1.5rem; vertical-align: middle;">
                <img src="https://receptia.corandar.com/corandar-logo.png" alt="Corandar" style="height: 22px; max-width: 120px; display: block; border: 0; outline: none; object-fit: contain;">
              </td>
            </tr>
          </table>

          <!-- Header con Logo de Receptia (Púrpura, esquinas redondeadas) -->
          <div style="background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%); padding: 2rem; text-align: center;">
            <div style="display: inline-block; background-color: rgba(255,255,255,0.1); padding: 0.5rem 1.25rem; border-radius: 12px; border: 1px solid rgba(255,255,255,0.2);">
              <span style="font-weight: 800; font-size: 1.4rem; color: #ffffff; letter-spacing: -0.025em; display: flex; align-items: center; gap: 0.35rem;">🔮 Receptia AI</span>
            </div>
            <p style="color: rgba(255,255,255,0.85); font-size: 0.95rem; margin: 0.75rem 0 0 0; font-weight: 500;">La revolución de agendamiento por Inteligencia Artificial</p>
          </div>

          <!-- Cuerpo -->
          <div style="padding: 2.5rem 2rem;">
            <h1 style="margin: 0 0 1.5rem 0; font-size: 1.55rem; font-weight: 700; color: #ffffff; text-align: left;">${subject}</h1>
            <div style="font-size: 1rem; color: #d1d5db;">
              ${bodyText.split('\n').map(p => p.trim() ? `<p style="margin: 0 0 1rem 0; line-height: 1.6; color: #d1d5db;">${p}</p>` : '').join('')}
            </div>
            
            <!-- Botón CTA principal de Receptia -->
            <div style="margin-top: 2.5rem; text-align: center;">
              <a href="${rewriteLink('https://receptia.corandar.com')}" style="background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%); color: #ffffff; padding: 0.85rem 2.25rem; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 0.95rem; display: inline-block; box-shadow: 0 4px 15px rgba(124, 58, 237, 0.4); transition: transform 0.2s;">
                Activar Mi Asistente IA
              </a>
            </div>
          </div>

          <!-- Footer con Logos de Receptia -->
          <div style="background-color: #0b0f19; padding: 2rem; border-top: 1px solid #1f2937; text-align: center;">
            <div style="display: flex; justify-content: center; align-items: center; gap: 1rem; margin-bottom: 1.25rem;">
              <div style="background-color: rgba(255, 255, 255, 0.05); padding: 0.35rem 0.65rem; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.1); display: inline-block;">
                <span style="font-weight: 800; font-size: 0.75rem; color: #d1d5db;">Receptia Admin</span>
              </div>
            </div>
            <p style="margin: 0; font-size: 0.75rem; color: #6b7280; line-height: 1.5;">Este es un comunicado comercial enviado por Receptia Inc.<br>Para asegurar la entrega, añade soporte@corandar.com a tu libreta de direcciones.<br><span style="font-size: 0.7rem; color: #6b7280;">Si no deseas recibir más correos de este tipo, puedes desuscribirte haciendo clic <a href="${baseUrl}/api/public/email-campaigns/unsubscribe/${recipientId}" target="_blank" style="color: #4b5563; text-decoration: underline;">aquí</a>.</span></p>
          </div>

        </div>
      </div>
    `;
  } else {
    // 3. Plantilla Receptia Newsletter (Clean Newsletter style)
    contentHtml = `
      <div style="background-color: #f9fafb; padding: 2rem 1rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border: 1px solid #e5e7eb;">
          
          <div style="background-color: #7c3aed; height: 6px;"></div>
          
          <!-- Header con logos en horizontal -->
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #ffffff; border-bottom: 1px solid #e5e7eb; width: 100%;">
            <tr>
              <td align="left" style="padding: 1rem 1.5rem; vertical-align: middle;">
                <img src="https://receptia.corandar.com/logo.png" alt="Receptia AI" style="height: 28px; max-width: 120px; display: block; border: 0; outline: none; object-fit: contain;">
              </td>
              <td align="right" style="padding: 1rem 1.5rem; vertical-align: middle;">
                <img src="https://receptia.corandar.com/corandar-logo.png" alt="Corandar" style="height: 22px; max-width: 120px; display: block; border: 0; outline: none; object-fit: contain;">
              </td>
            </tr>
          </table>

          <!-- Cuerpo -->
          <div style="padding: 2.5rem 2rem;">
            <h1 style="margin: 0 0 1.5rem 0; font-size: 1.45rem; font-weight: 700; color: #111827;">${subject}</h1>
            <div style="font-size: 1.05rem; color: #374151;">
              ${formattedBody}
            </div>
            
            <div style="margin-top: 2.5rem; text-align: center;">
              <a href="${rewriteLink('https://receptia.corandar.com')}" style="background-color: #7c3aed; color: #ffffff; padding: 0.75rem 1.75rem; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 0.9rem; display: inline-block;">
                Ver novedades en la web
              </a>
            </div>
          </div>

          <!-- Footer -->
          <div style="background-color: #f9fafb; padding: 1.5rem 2rem; border-top: 1px solid #f3f4f6; text-align: center;">
            <p style="margin: 0; font-size: 0.75rem; color: #9ca3af; line-height: 1.5;">© 2026 Receptia S.L. Todos los derechos reservados.<br><span style="font-size: 0.7rem; color: #9ca3af;">Si no deseas recibir más correos de este tipo, puedes desuscribirte haciendo clic <a href="${baseUrl}/api/public/email-campaigns/unsubscribe/${recipientId}" target="_blank" style="color: #6b7280; text-decoration: underline;">aquí</a>.</span></p>
          </div>

        </div>
      </div>
    `;
  }

  // Insertar píxel de tracking invisible al final del body
  return `${contentHtml}<img src="${trackOpenUrl}" width="1" height="1" alt="" style="display:none;" />`;
}

export default router;
