import axios from 'axios';
import { getSettingVal } from './supabase';

interface SendOutreachEmailRequest {
  businessName: string;
  toEmail: string;
  demoUrl: string;
  audioUrl: string;
  sector: string;
}

/**
 * Envía el correo electrónico personalizado de captación (Outreach) utilizando la API de Resend.
 * Soporta configuración dinámica de RESEND_API_KEY y RESEND_FROM_EMAIL.
 * Si no está configurada la clave, simula el envío con éxito.
 */
export async function sendOutreachEmail(req: SendOutreachEmailRequest): Promise<boolean> {
  const apiKey = await getSettingVal('RESEND_API_KEY') || process.env.RESEND_API_KEY;
  const fromEmail = await getSettingVal('RESEND_FROM_EMAIL') || process.env.RESEND_FROM_EMAIL || 'Receptia Demos <onboarding@resend.dev>';

  const subject = `🎙️ Hemos diseñado un Asistente de Voz IA para ${req.businessName}`;
  const htmlContent = getOutreachEmailTemplate(req.businessName, req.demoUrl, req.audioUrl, req.sector);

  if (!apiKey || apiKey === 'YOUR_RESEND_API_KEY') {
    console.log(`[Outreach Simulator] Enviando email de captación para ${req.businessName}...`);
    console.log(`[Outreach Simulator] Para: ${req.toEmail}`);
    console.log(`[Outreach Simulator] Asunto: ${subject}`);
    console.log(`[Outreach Simulator] Demo URL: ${req.demoUrl}`);
    console.log(`[Outreach Simulator] Audio URL: ${req.audioUrl}`);
    console.log('[Outreach Simulator] ✅ Email simulado enviado con éxito (Falta RESEND_API_KEY en Ajustes).');
    return true;
  }

  try {
    console.log(`[Outreach] Enviando email a ${req.toEmail} vía Resend...`);
    const response = await axios.post(
      'https://api.resend.com/emails',
      {
        from: fromEmail,
        to: [req.toEmail],
        subject: subject,
        html: htmlContent
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.status === 200 || response.status === 201) {
      console.log(`[Outreach] ✅ Email enviado exitosamente. Resend ID: ${response.data.id}`);
      return true;
    }
    
    throw new Error(`Resend API devolvió código de estado: ${response.status}`);
  } catch (error: any) {
    console.error('[Outreach ERROR] Fallo al enviar email a través de Resend:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Plantilla HTML de correo premium y responsive
 */
function getOutreachEmailTemplate(businessName: string, demoUrl: string, audioUrl: string, sector: string): string {
  const sectorTerm = sector.toLowerCase() === 'abogados' ? 'sus clientes' : 'sus pacientes';
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Asistente de Voz IA Personalizado</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #f3f4f6;
      color: #1f2937;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #f3f4f6;
      padding: 20px 0;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    }
    .header {
      background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%);
      padding: 40px 30px;
      text-align: center;
      color: #ffffff;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.025em;
    }
    .content {
      padding: 40px 30px;
      line-height: 1.6;
    }
    .content p {
      margin-top: 0;
      margin-bottom: 20px;
      font-size: 16px;
      color: #4b5563;
    }
    .audio-block {
      background-color: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      margin: 30px 0;
    }
    .audio-block h3 {
      margin-top: 0;
      margin-bottom: 12px;
      font-size: 16px;
      color: #111827;
      font-weight: 700;
    }
    .audio-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background-color: #1f2937;
      color: #ffffff !important;
      text-decoration: none;
      padding: 10px 20px;
      border-radius: 9999px;
      font-weight: 600;
      font-size: 14px;
      margin-top: 5px;
    }
    .cta-block {
      text-align: center;
      margin: 40px 0 20px 0;
    }
    .cta-btn {
      display: inline-block;
      background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%);
      color: #ffffff !important;
      text-decoration: none;
      padding: 16px 32px;
      border-radius: 12px;
      font-weight: 700;
      font-size: 16px;
      box-shadow: 0 4px 10px rgba(124, 58, 237, 0.3);
    }
    .footer {
      background-color: #f9fafb;
      border-top: 1px solid #e5e7eb;
      padding: 30px;
      text-align: center;
      font-size: 13px;
      color: #9ca3af;
    }
    .footer a {
      color: #7c3aed;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1>🎙️ Elena IA para ${businessName}</h1>
      </div>
      
      <div class="content">
        <p>Hola,</p>
        <p>Hemos analizado el sitio web de <strong>${businessName}</strong> y diseñado un agente de voz con Inteligencia Artificial hecho a su medida.</p>
        <p>Este asistente telefónico es capaz de atender a ${sectorTerm} las 24 horas del día, responder dudas frecuentes y agendar citas directamente en su calendario sin que pierda ninguna llamada cuando su equipo está ocupado o fuera de horario laboral.</p>
        
        <!-- Bloque de Audio Generado -->
        <div class="audio-block">
          <h3>🔊 Escuche su demostración personalizada</h3>
          <p style="font-size: 14px; margin-bottom: 12px; color: #6b7280;">Haga clic en el botón inferior para escuchar cómo se presentaría Elena IA al responder el teléfono de su negocio:</p>
          <a href="${audioUrl}" class="audio-btn" target="_blank">
            ▶️ Escuchar Audio Personalizado
          </a>
        </div>

        <p>Hemos habilitado un <strong>entorno de demostración privado y seguro</strong> donde podrá probar interactivamente el agente, ver la agenda de citas y configurar los ajustes del servicio en tiempo real.</p>
        
        <!-- CTA a la demo -->
        <div class="cta-block">
          <a href="${demoUrl}" class="cta-btn" target="_blank">
            Acceder a mi Panel Demo Gratis
          </a>
        </div>
      </div>
      
      <div class="footer">
        <p>Este correo electrónico fue generado automáticamente por <a href="https://receptia.corandar.com" target="_blank">Receptia</a>, una solución de Corandar, S.L.</p>
        <p>Para desactivar las demos y no recibir más emails, responda a este correo indicando "Baja".</p>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}
