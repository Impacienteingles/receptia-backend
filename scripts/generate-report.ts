import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 50, bottom: 50, left: 50, right: 50 },
  bufferPages: true
});

const outputFilePath = path.join('/Users/juanpablo/Desktop/APPS/Receptia', 'Reporte_Continuidad_Receptia.pdf');
const stream = fs.createWriteStream(outputFilePath);
doc.pipe(stream);

// Colores del tema (Premium Dark & Purple Receptia Theme)
const primaryColor = '#8b5cf6'; // Violeta Receptia
const secondaryColor = '#3b82f6'; // Azul
const darkColor = '#1f2937'; // Gris oscuro para texto principal
const mutedColor = '#6b7280'; // Gris muted
const lightBg = '#f9fafb'; // Fondo claro para cajas de código/notas
const whiteColor = '#ffffff';

// --- PÁGINA DE PORTADA ---
doc.rect(0, 0, 595.28, 841.89).fill('#080c14'); // Fondo oscuro premium

// Título de la portada
doc.fillColor('#ffffff')
   .font('Helvetica-Bold')
   .fontSize(36)
   .text('RECEPTIA', 50, 220);

doc.fillColor(primaryColor)
   .fontSize(18)
   .text('Auditoría Técnica, Análisis de Paneles y Manual de Continuidad', 50, 270);

doc.rect(50, 310, 150, 4).fill(primaryColor); // Línea decorativa

doc.fillColor('#9ca3af')
   .font('Helvetica')
   .fontSize(12)
   .text('Una plataforma SaaS multi-inquilino de recepción telefónica e IA conversacional.', 50, 340, { width: 480 });

// Metadatos de la portada
doc.fillColor('#d1d5db')
   .fontSize(10)
   .text('Autor: Antigravity AI Coding Assistant', 50, 580)
   .text('Fecha de Emisión: 30 de Junio, 2026', 50, 600)
   .text('Estado de Madurez: Listo para Operación Comercial Limitada (Fase de Parches)', 50, 620);

// Fin de portada, nueva página
doc.addPage();

// --- CONFIGURACIÓN DE ENCABEZADO Y PIE DE PÁGINA DINÁMICOS ---
// Usaremos el buffer de páginas para renderizar headers y footers al final
const addHeadersAndFooters = () => {
  const pages = doc.bufferedPageRange();
  for (let i = 1; i < pages.count; i++) { // Evitar portada (página 0)
    doc.switchToPage(i);
    
    // Encabezado
    doc.fillColor(mutedColor)
       .font('Helvetica-Oblique')
       .fontSize(8)
       .text('RECEPTIA - Reporte Técnico y de Continuidad', 50, 25, { align: 'left' });
    
    doc.strokeColor('rgba(0,0,0,0.08)')
       .lineWidth(0.5)
       .moveTo(50, 38)
       .lineTo(545, 38)
       .stroke();

    // Pie de página
    doc.strokeColor('rgba(0,0,0,0.08)')
       .lineWidth(0.5)
       .moveTo(50, 800)
       .lineTo(545, 800)
       .stroke();

    doc.fillColor(mutedColor)
       .font('Helvetica')
       .fontSize(8)
       .text(`Página ${i + 1} de ${pages.count}`, 50, 810, { align: 'right' });
  }
};

// --- RENDERIZACIÓN DE CONTENIDO ---

// Helper para títulos de sección (H1)
const renderH1 = (text: string) => {
  doc.moveDown(1.5);
  const currentY = doc.y;
  doc.rect(50, currentY, 4, 22).fill(primaryColor); // Barra lateral violeta
  doc.fillColor('#0f172a')
     .font('Helvetica-Bold')
     .fontSize(16)
     .text(text, 62, currentY + 2);
  doc.moveDown(1);
};

// Helper para subtítulos (H2)
const renderH2 = (text: string) => {
  doc.moveDown(1);
  doc.fillColor('#1e293b')
     .font('Helvetica-Bold')
     .fontSize(12)
     .text(text, 50, doc.y);
  doc.moveDown(0.5);
};

// Helper para párrafos
const renderParagraph = (text: string) => {
  doc.fillColor(darkColor)
     .font('Helvetica')
     .fontSize(10)
     .text(text, { align: 'justify', lineGap: 3 });
  doc.moveDown(0.8);
};

// Helper para listas con viñetas
const renderBullet = (title: string, desc: string) => {
  const currentY = doc.y;
  doc.fillColor(primaryColor).fontSize(10).text('•', 55, currentY);
  doc.fillColor(darkColor)
     .font('Helvetica-Bold')
     .text(title + ': ', 68, currentY, { continued: true })
     .font('Helvetica')
     .text(desc, { lineGap: 2 });
  doc.moveDown(0.4);
};

// Helper para cajas de alerta / notas
const renderNoteBox = (title: string, text: string, type: 'warning' | 'info' = 'info') => {
  doc.moveDown(0.5);
  const currentY = doc.y;
  const boxColor = type === 'warning' ? '#fef2f2' : '#f0fdf4';
  const borderColor = type === 'warning' ? '#fca5a5' : '#86efac';
  const textColor = type === 'warning' ? '#991b1b' : '#166534';
  
  doc.rect(50, currentY, 495, 60).fill(boxColor);
  doc.rect(50, currentY, 4, 60).fill(borderColor);
  
  doc.fillColor(textColor)
     .font('Helvetica-Bold')
     .fontSize(9)
     .text(title.toUpperCase(), 65, currentY + 8)
     .font('Helvetica')
     .fontSize(8.5)
     .text(text, 65, currentY + 22, { width: 460, lineGap: 1 });
     
  doc.y = currentY + 65;
  doc.moveDown(0.5);
};


// 1. INTRODUCCIÓN Y ARQUITECTURA
renderH1('1. Arquitectura General y Stack Tecnológico');
renderParagraph('Receptia está estructurado como una aplicación Node.js modular escrita en TypeScript, exponiendo un servidor web mediante Express y utilizando una base de datos PostgreSQL alojada en Supabase como núcleo de persistencia.');
renderParagraph('El sistema opera bajo un enfoque multi-inquilino (Multi-Tenant), donde cada cliente comercial (tenant) cuenta con su propia configuración de asistente de voz (Retell AI), su agenda conectada (Google Calendar), su canal de chat (WhatsApp Web/Twilio) y su ciclo de facturación (Stripe).');

renderH2('Componentes Clave e Integraciones:');
renderBullet('Servidor Core', 'Node.js v22+ con Express y TypeScript.');
renderBullet('Base de Datos', 'Supabase (PostgreSQL 15+) con RLS y Storage para assets públicos y audios de demostración.');
renderBullet('Agente de Voz', 'Retell AI (API v2) inyectando prompts de sistema dinámicos personalizados.');
renderBullet('Agente de Texto', 'Gemini 2.5 Flash de Google, empleado en el widget de chat y chatbot de WhatsApp.');
renderBullet('Calendario', 'Google Calendar API v3 con flujo OAuth2 offline e invitaciones automáticas por correo.');
renderBullet('Facturación', 'Stripe API con planes mensuales/anuales y cobro por consumo de minutos excedentes.');
renderBullet('Comunicaciones', '@whiskeysockets/baileys para WhatsApp Web local (QR) y Twilio para SMS/WhatsApp premium.');
renderBullet('Clonación de Voces', 'Cartesia AI y ElevenLabs para generación de voz ultrarrealista personalizada.');

doc.addPage();

// 2. MODELO DE DATOS
renderH1('2. Esquema de Base de Datos (Supabase / PostgreSQL)');
renderParagraph('La base de datos se estructura alrededor del inquilino (tenant) y almacena las citas, logs de llamadas, mensajes de chat y prospectos de la plataforma.');

renderH2('Tablas Principales:');
renderBullet('tenants', 'Almacena el perfil del comercio, configuraciones de la IA (voz, velocidad, tono), credenciales OAuth de Google Calendar, IDs de Stripe y Retell.');
renderBullet('appointments', 'Gestiona las citas programadas. Relaciona el inquilino (tenant_id), el cliente/paciente (nombre, email, teléfono), la hora de inicio y el ID del evento de Google Calendar.');
renderBullet('call_logs', 'Guarda el historial de llamadas de Retell, incluyendo transcripciones de diálogos, resúmenes automáticos por IA, duración de la llamada y URL de grabación.');
renderBullet('chat_messages', 'Almacena los mensajes enviados y recibidos tanto en WhatsApp Web como en el widget de chat web.');
renderBullet('prospects', 'Leads extraídos mediante scraping de Google Maps que incluyen nombre, web, email, estado de la demo y sector. Es el corazón del pipeline de ventas.');
renderBullet('settings', 'Configuraciones globales del sistema (API keys globales de Stripe, Retell, Gemini, etc.).');
renderBullet('whatsapp_auth_states', 'Tabla crítica (añadida para persistencia) que guarda el estado de autenticación multi-dispositivo de Baileys en Supabase.');

renderNoteBox('Inconsistencia en DDL inicial', 'La tabla "whatsapp_auth_states" no existía en el script inicial "supabase_schema.sql". Se requiere su creación manual para que las sesiones de WhatsApp no se cierren al reiniciar el backend.', 'warning');

doc.addPage();

// 3. ANÁLISIS DE PANELES Y MENÚS
renderH1('3. Desglose de Paneles y Opciones de Menú');
renderParagraph('Receptia expone tres paneles de control independientes según el rol del usuario, optimizados con diseños modernos y persistencia de estados.');

renderH2('3.1. Panel de Administrador (admin.html)');
renderParagraph('Panel central para el dueño de Receptia. Sus opciones incluyen:');
renderBullet('Dashboard de Prospección', 'Buscador de leads en frío por Ciudad y Sector. Permite buscar comercios en Google Maps, generarles una demo en un clic y enviar correos de captación.');
renderBullet('Acordeones de Ciudades', 'Agrupación de prospectos por ciudad geográfica. Cuenta con memoria de plegado/desplegado y ordenación dinámica por Nombre, Sector, Clasificación y Estado.');
renderBullet('Gestión de Inquilinos', 'Lista de comercios activos, edición de parámetros de facturación, y opción de archivar (soft delete).');
renderBullet('Administración Contable', 'Visualización de ingresos mensuales de Stripe y registro de transacciones manuales.');
renderBullet('Plantillas de Contrato', 'Creador de contratos legales en HTML para firma electrónica de los nuevos comercios.');
renderBullet('Configuración Global', 'Administración de API Keys del sistema y configuración de voces clonadas.');

renderH2('3.2. Panel de Cliente / Comercio (app.html)');
renderParagraph('Panel al que accede cada comercio para configurar su secretaria virtual:');
renderBullet('Configuración de Asistente', 'Personalización del tono de voz (formal/coloquial), velocidad, instrucciones de agenda, servicios que ofrece y modo vacaciones.');
renderBullet('Integración de Agenda', 'Vinculación directa a Google Calendar con un clic usando OAuth2 offline.');
renderBullet('WhatsApp Widget', 'Sección para conectar WhatsApp Web escaneando el código QR generado en pantalla.');
renderBullet('Facturación y Stripe', 'Acceso directo al portal de suscripción de Stripe, planes y logs de cobros.');
renderBullet('Contrato y Firma', 'Visor y firmador digital de la plantilla del contrato de prestación de servicios.');

renderH2('3.3. Panel de Comercial (comercial.html)');
renderBullet('Métricas de Rendimiento', 'Tarjetas con leads asignados, contactados, en negociación y convertidos a clientes.');
renderBullet('Pipeline de Ventas', 'Listado de comercios asignados para seguimiento telefónico y actualización de su clasificación comercial.');

doc.addPage();

// 4. FLUJOS LÓGICOS Y REGLAS DE NEGOCIO
renderH1('4. Flujos Lógicos y Reglas de Negocio Especiales');
renderParagraph('Receptia cuenta con varios algoritmos y reglas propietarias inyectadas directamente en los controladores del backend:');

renderH2('4.1. El Pipeline de Prospección en Frío');
renderParagraph('Al activar una demo para un prospecto:');
renderBullet('1. Creación de Tenant Temporal', 'Se duplica un inquilino de prueba adaptando su nombre y servicios.');
renderBullet('2. Aprovisionamiento de Retell', 'Se crea un agente de Retell AI inyectando las herramientas de agendamiento asociadas.');
renderBullet('3. Generación de Audio', 'Cartesia AI sintetiza un mensaje personalizado saludando al comercio por su nombre y ofreciendo 7 días de prueba gratis.');
renderBullet('4. Envío de Outreach', 'Resend envía un email premium con el panel de control demo, el audio personalizado y un píxel de seguimiento de apertura.');

renderH2('4.2. Depósito Obligatorio de Reserva (No-Show Deposits)');
renderParagraph('Para evitar ausencias imprevistas de clientes:');
renderBullet('1. Bloqueo de Disponibilidad', 'El asistente agenda la cita en Google Calendar como "[PENDIENTE DE PAGO]" con status "pending_payment".');
renderBullet('2. Link de Pago', 'Se envía inmediatamente un link de Stripe Checkout por WhatsApp al cliente.');
renderBullet('3. Confirmación Webhook', 'Al pagar, el webhook de Stripe cambia el estado a "confirmed" y limpia el prefijo en el calendario.');

renderH2('4.3. Regla de Descansos de Peluquería Carlos Romero');
renderParagraph('Lógica estricta en "googleCalendar.ts": para el tenant especificado, por cada 2 bloques de citas consecutivos (30 min), se exige dejar un bloque (15 min) libre para descanso del peluquero, evitando fatiga.');

renderH2('4.4. Facturación Metrada por Minuto Excedente');
renderParagraph('El sistema acumula la duración de llamadas del ciclo actual del inquilino, calcula los minutos excedentes sobre el límite del plan (Standard: 200 min, Premium: 500 min) y los reporta a Stripe en segundo plano.');

doc.addPage();

// 5. DEBILIDADES Y RECOMENDACIONES DE SEGURIDAD
renderH1('5. Debilidades del Código y Recomendaciones de Seguridad');
renderParagraph('Se han detectado vulnerabilidades críticas en el código del servidor backend que deben subsanarse inmediatamente antes de la comercialización en masa:');

renderH2('5.1. Exposición Crítica de API Keys Privadas (Vulnerabilidad Alta)');
renderParagraph('El endpoint GET /api/admin/settings NO cuenta con ningún tipo de middleware de autenticación. Cualquier usuario malintencionado puede hacer una petición HTTP a este endpoint y recibir en texto plano las credenciales privadas de Stripe, Retell, Gemini, ElevenLabs y Cartesia.');
renderNoteBox('Acción requerida inmediata', 'Agregar el middleware "verifyToken" al endpoint GET y POST de /api/admin/settings para restringir el acceso únicamente a administradores autorizados.', 'warning');

renderH2('5.2. Reset Automático de Planes en Base de Datos');
renderParagraph('El backend ejecuta sentencias destructivas (DELETE FROM plans) en su script de inicialización durante el arranque. Si el administrador edita un precio o característica en Supabase, esta modificación se borrará restableciendo los valores hardcodeados en el arranque.');

renderH2('5.3. Fugas de Sockets de WhatsApp Web');
renderParagraph('La reconexión automática de Baileys al fallar la red puede levantar múltiples sockets paralelos, consumiendo la pila de memoria RAM de Render y provocando la desconexión del servidor.');

doc.addPage();

// 6. INFORME DE MADUREZ COMERCIAL
renderH1('6. Conclusión y Recomendación Comercial');
renderParagraph('Receptia es una obra de ingeniería conversacional sumamente completa, con un diseño premium y flujos integrados de pago, contratos y agendamiento que la sitúan muy por encima de los productos viables mínimos del mercado.');

renderH2('Estado Actual: Listo para Operación Comercial Limitada (Controlled Beta)');
renderParagraph('Receptia puede utilizarse comercialmente de inmediato bajo una fase controlada (Beta cerrada) con clientes de confianza, asegurando el monitoreo constante de los logs.');
renderParagraph('Para una comercialización abierta y masiva, es OBLIGATORIO parchear los endpoints de settings expuestos y asegurar la estabilidad de la reconexión de WhatsApp Web.');

// RENDERIZAR HEADERS Y FOOTERS AL FINAL
addHeadersAndFooters();

doc.end();

stream.on('finish', () => {
  console.log('PDF generado exitosamente en:', outputFilePath);
});
