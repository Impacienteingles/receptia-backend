import axios from 'axios';
import { getSettingVal } from './supabase';

interface SendOutreachEmailRequest {
  prospectId?: string;
  originUrl?: string;
  businessName: string;
  toEmail: string;
  demoUrl: string;
  audioUrl: string;
  sector: string;
  subject?: string;
  bodyOverride?: string;
  voiceId?: string;
}

/**
 * Envía el correo electrónico personalizado de captación (Outreach) utilizando la API de Resend.
 * Soporta configuración dinámica de RESEND_API_KEY y RESEND_FROM_EMAIL.
 * Si no está configurada la clave, lanza un error claro.
 */
export async function sendOutreachEmail(req: SendOutreachEmailRequest): Promise<boolean> {
  const apiKey = await getSettingVal('RESEND_API_KEY') || process.env.RESEND_API_KEY;
  const fromEmail = await getSettingVal('RESEND_FROM_EMAIL') || process.env.RESEND_FROM_EMAIL || 'Receptia Demos <onboarding@resend.dev>';

  const subject = req.subject || `🎙️ Hemos diseñado un Asistente de Voz IA para ${req.businessName}`;
  let htmlContent = getOutreachEmailTemplate(req.businessName, req.demoUrl, req.audioUrl, req.sector, req.bodyOverride, req.voiceId);

  // Inyectar píxel de seguimiento si se proveen los parámetros necesarios
  if (req.prospectId && req.originUrl) {
    const trackingPixel = `<img src="${req.originUrl}/api/outreach/track-open?prospect_id=${req.prospectId}" width="1" height="1" style="display:none !important;" alt="" />`;
    htmlContent = htmlContent.replace('</body>', `${trackingPixel}</body>`);
  }

  if (!apiKey || apiKey === 'YOUR_RESEND_API_KEY') {
    const errorMsg = 'No se ha configurado la clave de API de Resend (RESEND_API_KEY) en los Ajustes. Por favor, añada sus credenciales de Resend para poder realizar envíos reales.';
    console.warn(`[Outreach Warning] ${errorMsg}`);
    throw new Error(errorMsg);
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
    const errorDetail = error.response?.data?.message || error.response?.data?.error || error.message;
    const finalDetail = typeof errorDetail === 'object' ? JSON.stringify(errorDetail) : errorDetail;
    throw new Error(`Error de Resend: ${finalDetail}`);
  }
}

/**
 * Convierte texto plano con saltos de línea y marcas **negrita** a HTML.
 */
export function parseBodyToHtml(text: string): string {
  const cleanText = text.replace(/\r\n/g, '\n');
  const processedText = cleanText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  const paragraphs = processedText.split(/\n\s*\n/);
  return paragraphs
    .map(p => {
      const line = p.trim().replace(/\n/g, '<br>');
      return `<p>${line}</p>`;
    })
    .join('\n');
}

/**
 * Plantilla HTML de correo premium y responsive
 */
export function getOutreachEmailTemplate(businessName: string, demoUrl: string, audioUrl: string, sector: string, bodyOverride?: string, voiceId?: string): string {
  let voiceName = 'Elena IA';
  if (voiceId) {
    const vId = voiceId.toLowerCase();
    if (vId.includes('cefcb124') || vId.includes('elena')) voiceName = 'Elena IA';
    else if (vId.includes('f05c3034') || vId.includes('ines') || vId.includes('9d8c6b2e') || vId.includes('nuria')) voiceName = 'Inés IA';
    else if (vId.includes('b5aa8098') || vId.includes('manuel')) voiceName = 'Manuel IA';
    else if (vId.includes('515324df') || vId.includes('dario') || vId.includes('13ff5deb') || vId.includes('marcos')) voiceName = 'Darío IA';
    else if (vId.includes('156fb8d2') || vId.includes('sarah')) voiceName = 'Sarah IA';
    else if (vId.includes('248be419') || vId.includes('emily') || vId.includes('db6b0ed5') || vId.includes('skylar')) voiceName = 'Emily IA';
    else if (vId.includes('5c5ad5e7') || vId.includes('sofia')) voiceName = 'Sofía IA';
    else if (vId.includes('b4eeae21') || vId.includes('lola') || vId.includes('3797b3c0') || vId.includes('carolina')) voiceName = 'Lola IA';
  }
  const cleanVoiceName = voiceName.replace(' IA', '');
  const sectorTerm = sector.toLowerCase() === 'abogados' ? 'sus clientes' : 'sus pacientes';
  
  let bodyHtml = '';
  if (bodyOverride) {
    bodyHtml = parseBodyToHtml(bodyOverride);
  } else {
    bodyHtml = `
        <p>Estimado/a responsable de <span class="highlight">${businessName}</span>,</p>
        
        <p>Desde <span class="highlight">Corándar</span> hemos diseñado y configurado un <span class="highlight">Agente de Voz con Inteligencia Artificial</span> adaptado a las necesidades específicas de su negocio.</p>
        
        <p>Este agente es capaz de atender llamadas telefónicas las 24 horas del día, responder consultas detalladas sobre sus servicios, y agendar citas de forma completamente autónoma directamente en su calendario.</p>
    `;
  }
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tu Asistente de Voz con Inteligencia Artificial - Receptia</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Outfit", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #0b0f19;
      color: #f3f4f6;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #0b0f19;
      padding: 40px 0;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #111827;
      border-radius: 24px;
      overflow: hidden;
      border: 1px solid #1f2937;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4);
    }
    .header {
      background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%);
      padding: 50px 40px;
      text-align: center;
      color: #ffffff;
      position: relative;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.2;
    }
    .header p {
      margin: 10px 0 0 0;
      font-size: 15px;
      color: #c084fc;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .content {
      padding: 40px;
      line-height: 1.7;
    }
    .content p {
      margin-top: 0;
      margin-bottom: 24px;
      font-size: 16px;
      color: #9ca3af;
    }
    .highlight {
      color: #ffffff;
      font-weight: 600;
    }
    
    /* Mockup Premium Card for Play/Demo */
    .dashboard-mockup {
      background-color: #1f2937;
      border: 1px solid #374151;
      border-radius: 16px;
      padding: 24px;
      margin: 35px 0;
      text-align: center;
      text-decoration: none !important;
      display: block;
      transition: all 0.3s ease;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .dashboard-mockup:hover {
      border-color: #6d28d9;
      box-shadow: 0 0 20px rgba(109, 40, 217, 0.3);
    }
    .mockup-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      border-bottom: 1px solid #374151;
      padding-bottom: 12px;
    }
    .mockup-title {
      color: #f3f4f6;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .mockup-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #10b981;
      font-size: 12px;
      font-weight: 600;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      background-color: #10b981;
      border-radius: 50%;
      display: inline-block;
      box-shadow: 0 0 8px #10b981;
    }
    .mockup-preview-body {
      background: linear-gradient(180deg, #111827 0%, #0f172a 100%);
      border-radius: 12px;
      padding: 30px 20px;
      border: 1px solid #374151;
      position: relative;
    }
    .play-circle {
      width: 70px;
      height: 70px;
      background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%);
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 15px auto;
      box-shadow: 0 8px 16px rgba(124, 58, 237, 0.4);
    }
    .play-icon {
      width: 0;
      height: 0;
      border-top: 12px solid transparent;
      border-left: 20px solid #ffffff;
      border-bottom: 12px solid transparent;
      margin-left: 5px;
      display: inline-block;
    }
    .mockup-button-text {
      color: #ffffff;
      font-weight: 700;
      font-size: 16px;
      margin-bottom: 4px;
    }
    .mockup-subtext {
      color: #6b7280;
      font-size: 13px;
    }

    /* Benefits Table */
    .benefits-grid {
      width: 100%;
      margin: 30px 0;
      border-collapse: collapse;
    }
    .benefit-card {
      background-color: #1f2937;
      border: 1px solid #374151;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .benefit-title {
      color: #ffffff;
      font-weight: 700;
      font-size: 15px;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .benefit-desc {
      color: #9ca3af;
      font-size: 14px;
      margin: 0;
      line-height: 1.5;
    }

    .corandar-card {
      display: flex;
      align-items: center;
      gap: 15px;
      background: rgba(99, 102, 241, 0.05);
      border: 1px dashed rgba(99, 102, 241, 0.3);
      border-radius: 12px;
      padding: 16px;
      margin: 20px 0;
      text-decoration: none;
      color: #ffffff !important;
      transition: all 0.3s ease;
    }
    .corandar-card:hover {
      background: rgba(99, 102, 241, 0.1);
      border-color: rgba(99, 102, 241, 0.5);
    }
    .corandar-card-icon {
      font-size: 28px;
    }
    .corandar-card-title {
      font-weight: 700;
      color: #a78bfa;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .corandar-card-desc {
      font-size: 13px;
      color: #9ca3af;
      margin-top: 4px;
      line-height: 1.4;
    }
    .corandar-card-arrow {
      color: #a78bfa;
      font-size: 18px;
      font-weight: bold;
      margin-left: auto;
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
      padding: 16px 36px;
      border-radius: 14px;
      font-weight: 700;
      font-size: 16px;
      box-shadow: 0 10px 15px -3px rgba(124, 58, 237, 0.4);
      transition: all 0.3s ease;
    }
    
    .footer {
      background-color: #0f172a;
      border-top: 1px solid #1f2937;
      padding: 30px;
      text-align: center;
      font-size: 13px;
      color: #6b7280;
    }
    .footer a {
      color: #a78bfa;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <p>Demostración Exclusiva</p>
        <h1>Asistente de Voz Inteligente para ${businessName}</h1>
      </div>
      
      <div class="content">
        ${bodyHtml}

        <!-- Tarjeta Ficha de Corandar -->
        <a href="https://receptia.corandar.com" class="corandar-card" target="_blank">
          <div style="background-color: #ffffff; padding: 6px; border-radius: 8px; display: flex; align-items: center; justify-content: center; width: 110px; min-width: 110px; height: 34px; box-sizing: border-box; border: 1px solid #e5e7eb;">
            <img src="https://receptia.corandar.com/corandar_logo.png" alt="Logo Corandar" style="max-width: 100%; max-height: 100%; object-fit: contain;">
          </div>
          <div style="text-align: left;">
            <div class="corandar-card-title">Desarrollado por Corándar</div>
            <div class="corandar-card-desc">Visite la landing page de Receptia para descubrir cómo nuestra IA puede automatizar la atención de su negocio.</div>
          </div>
          <div class="corandar-card-arrow">→</div>
        </a>

        <!-- Tarjeta de Mockup del Reproductor de Audio -->
        <a href="${audioUrl}" class="dashboard-mockup" target="_blank">
          <div class="mockup-header">
            <span class="mockup-title">🔊 Presentación Telefónica de ${voiceName}</span>
            <span class="mockup-status">
              <span class="status-dot"></span> LISTO PARA ESCUCHAR
            </span>
          </div>
          <div class="mockup-preview-body">
            <div class="play-circle">
              <span class="play-icon"></span>
            </div>
            <div class="mockup-button-text">Escuchar demo de audio</div>
            <div class="mockup-subtext">Haga clic aquí para escuchar cómo se presentará ${voiceName} al atender a sus clientes.</div>
          </div>
        </a>

        <p>Además de esta presentación en audio, le hemos configurado una <span class="highlight">Demostración Real e Interactiva</span> de su receptor virtual de llamadas en su <strong>Panel de Control de Cliente</strong> privado.</p>
        
        <p>Para ver el historial, el simulador y las grabaciones, acceda a su panel desde el enlace de abajo y vaya a la pestaña <span class="highlight">"Llamadas IA"</span>. Para iniciar sesión, utilice su correo electrónico y su contraseña de acceso temporal: <strong style="color: #60a5fa; font-family: monospace; font-size: 1.1em; background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1);">Receptia123!</strong>.</p>

        <!-- Beneficios en tarjetas -->
        <div class="benefit-card">
          <div class="benefit-title">📞 Recepción Disponible 24/7</div>
          <p class="benefit-desc">${cleanVoiceName} atiende llamadas de forma instantánea a cualquier hora, evitando que pierda clientes cuando su equipo está ocupado o fuera de horario comercial.</p>
        </div>

        <div class="benefit-card">
          <div class="benefit-title">📅 Gestión Automática de Agenda</div>
          <p class="benefit-desc">Permite a ${sectorTerm} reservar, modificar o cancelar citas directamente en el sistema de manera natural y sin errores.</p>
        </div>

        <div class="benefit-card">
          <div class="benefit-title">🧮 Calculadora de ROI Integrada</div>
          <p class="benefit-desc">Descubra el impacto económico directo en su negocio. Pruebe la calculadora en su panel para estimar cuánto dinero y cuántas citas está perdiendo al mes por llamadas no atendidas, y cómo Receptia las recuperará.</p>
        </div>

        <div class="benefit-card">
          <div class="benefit-title">🧠 Base de Conocimientos del Negocio</div>
          <p class="benefit-desc">El agente ha sido entrenado con la información de su establecimiento para responder preguntas sobre servicios, precios y dirección legal.</p>
        </div>

        <!-- Botón de Acción Principal a la Demo -->
        <div class="cta-block">
          <a href="${demoUrl}" class="cta-btn" target="_blank">
            Acceder a mi Panel de Control Demo ↗
          </a>
        </div>
      </div>
      
      <div class="footer">
        <p>Este correo electrónico fue generado automáticamente por <a href="https://receptia.corandar.com" target="_blank">Receptia</a>, una solución de <a href="https://receptia.corandar.com" target="_blank">Corándar, S.L.</a></p>
        <p>Para no recibir más demostraciones, responda indicando "Baja" y procesaremos su solicitud de inmediato.</p>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}
