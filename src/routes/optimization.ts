import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { exec } from 'child_process';
import { supabase } from '../services/supabase';

const router = Router();
const BACKUP_DIR = path.join(process.cwd(), 'public', 'backups');

// Asegurar que la carpeta de copias de seguridad existe
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Mapeador de paneles a rutas de archivo físicas
const PANEL_PATHS: Record<string, string> = {
  admin: path.join(process.cwd(), 'public', 'admin.html'),
  client: path.join(process.cwd(), 'public', 'app.html'),
  comercial: path.join(process.cwd(), 'public', 'comercial.html')
};

// Helper para ejecutar comandos en el sistema de forma asíncrona
function runCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        reject(stderr || stdout || error.message);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Endpoint para listar todas las copias de seguridad disponibles en el servidor
 */
router.get('/backups', async (req: Request, res: Response) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return res.json({ backups: [] });
    }

    const files = fs.readdirSync(BACKUP_DIR);
    const backups = files
      .filter(file => file.endsWith('.html') && file.includes('_backup_'))
      .map(file => {
        const stats = fs.statSync(path.join(BACKUP_DIR, file));
        const parts = file.split('_backup_');
        const panel = parts[0];
        const timestampStr = parts[1].replace('.html', '');
        const timestamp = parseInt(timestampStr, 10);
        
        return {
          filename: file,
          panel,
          timestamp,
          date: new Date(timestamp).toLocaleString('es-ES'),
          sizeBytes: stats.size
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp); // Más recientes primero

    res.json({ backups });
  } catch (err: any) {
    console.error('[Optimization Router] Error listing backups:', err.message);
    res.status(500).json({ error: 'Error al listar copias de seguridad.', details: err.message });
  }
});

/**
 * Endpoint para restaurar una copia de seguridad específica
 */
router.post('/restore', async (req: Request, res: Response) => {
  const { filename } = req.body;
  
  if (!filename) {
    return res.status(400).json({ error: 'El nombre del archivo de backup es obligatorio.' });
  }

  try {
    const backupPath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'El archivo de copia de seguridad no existe.' });
    }

    const parts = filename.split('_backup_');
    const panel = parts[0];
    const targetPath = PANEL_PATHS[panel];

    if (!targetPath) {
      return res.status(400).json({ error: 'Panel inválido para la restauración.' });
    }

    // Copiar el contenido del backup al archivo original
    fs.copyFileSync(backupPath, targetPath);
    console.log(`[Optimization] Restauración completada: ${filename} -> ${targetPath}`);
    
    res.json({ status: 'success', message: `Panel de ${panel} restaurado con éxito desde ${filename}.` });
  } catch (err: any) {
    console.error('[Optimization Router] Error during restore:', err.message);
    res.status(500).json({ error: 'Error al restaurar copia de seguridad.', details: err.message });
  }
});

/**
 * Endpoint principal para ejecutar un agente autónomo de IA de optimización y depuración sobre un panel
 */
router.post('/run-agent', async (req: Request, res: Response): Promise<void> => {
  const { panel, instruction } = req.body;

  if (!panel || !PANEL_PATHS[panel]) {
    res.status(400).json({ error: 'Especifica un panel válido: admin, client o comercial.' });
    return;
  }

  const targetPath = PANEL_PATHS[panel];
  if (!fs.existsSync(targetPath)) {
    res.status(404).json({ error: `El archivo del panel de ${panel} no fue encontrado en la ruta.` });
    return;
  }

  // 1. Obtener la clave API de Gemini desde Supabase
  let apiKey = '';
  try {
    const { data } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'GEMINI_API_KEY')
      .maybeSingle();
    apiKey = data?.value || '';
  } catch (e) {
    console.warn('[Optimization] Error al consultar GEMINI_API_KEY, buscando en env...');
  }

  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY') {
    apiKey = process.env.GEMINI_API_KEY || '';
  }

  if (!apiKey) {
    res.status(500).json({ error: 'La clave GEMINI_API_KEY no está configurada en la plataforma.' });
    return;
  }

  const backupFilename = `${panel}_backup_${Date.now()}.html`;
  const backupPath = path.join(BACKUP_DIR, backupFilename);
  
  // 2. Crear una copia de seguridad física
  try {
    fs.copyFileSync(targetPath, backupPath);
    console.log(`[Optimization] Backup de seguridad creado: ${backupFilename}`);
  } catch (err: any) {
    res.status(500).json({ error: 'No se pudo crear la copia de seguridad de respaldo antes del proceso.', details: err.message });
    return;
  }

  try {
    // 3. Leer el contenido completo del panel
    const sourceCode = fs.readFileSync(targetPath, 'utf8');

    // 4. Configurar la llamada a Gemini 2.5 Pro (especializado en código y grandes contextos)
    const modelUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;
    
    const systemPrompt = `Eres un programador Full Stack experto y un agente de auto-reparación automatizado. Tu misión es optimizar y reparar el código fuente de la vista web "${panel}.html" proporcionada.
Deberás aplicar con la máxima precisión la orden del usuario para corregir bugs, refactorizar código o añadir características nuevas.
Asegúrate de:
1. Mantener todas las clases CSS existentes, lógica de control, llamadas AJAX y estilos inline que no deban ser modificados.
2. Comprobar que no rompes el árbol DOM de HTML ni la sintaxis de JavaScript.
3. REGLA DE ORO CRÍTICA: Tu salida debe ser ÚNICAMENTE el código fuente HTML/JS completo resultante corregido. NO envuelvas la respuesta en bloques de código markdown de triple acento grave (\`\`\`), NO agregues explicaciones, notas, ni textos introductorios. Tu respuesta debe comenzar con "<!DOCTYPE html>" y terminar con "</html>".`;

    const userPrompt = `A continuación se te presenta el código completo del panel "${panel}". Optimízalo o repáralo aplicando esta instrucción del administrador:
"${instruction || 'Realiza una revisión, optimización general y limpieza de funciones redundantes en el código.'}"

Código fuente original:
${sourceCode}`;

    const payload = {
      contents: [{
        role: 'user',
        parts: [{ text: userPrompt }]
      }],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      }
    };

    console.log(`[Optimization Agent] Ejecutando optimización en segundo plano sobre ${panel}...`);
    
    const geminiRes = await axios.post(modelUrl, payload, { timeout: 120000 }); // 2 minutos de timeout por el volumen del archivo
    let textResponse = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!textResponse || textResponse.trim() === '') {
      throw new Error('El modelo de inteligencia artificial retornó una respuesta vacía.');
    }

    // Limpiar posibles bloques markdown accidentales de Gemini
    let cleanCode = textResponse.trim();
    if (cleanCode.startsWith('```html')) {
      cleanCode = cleanCode.substring(7);
    } else if (cleanCode.startsWith('```')) {
      cleanCode = cleanCode.substring(3);
    }
    if (cleanCode.endsWith('```')) {
      cleanCode = cleanCode.substring(0, cleanCode.length - 3);
    }
    cleanCode = cleanCode.trim();

    // 5. Sobreescribir el archivo original
    fs.writeFileSync(targetPath, cleanCode, 'utf8');
    console.log(`[Optimization Agent] Código fuente de ${panel} sobreescrito en el servidor.`);

    // 6. Test de Validación de Compilación (Rollback Automático si falla)
    console.log('[Optimization Agent] Iniciando validación de compilación del proyecto...');
    try {
      // Intentamos ejecutar el compilador TypeScript para certificar que el build funciona
      await runCommand('PATH="/Users/juanpablo/node-dist/bin:$PATH" npm run build');
      console.log('✅ [Optimization Agent] Validación de compilación exitosa. Sin errores de TypeScript.');
      
      res.json({
        status: 'success',
        message: `El panel de ${panel} fue optimizado y desplegado correctamente en producción.`,
        backup: backupFilename
      });
    } catch (buildError: any) {
      console.error('❌ [Optimization Agent] Error de compilación detectado tras optimizar. Iniciando auto-rollback de seguridad...');
      // Restauramos el backup inmediatamente de forma segura
      fs.copyFileSync(backupPath, targetPath);
      console.log('[Optimization Agent] Rollback de seguridad completado. Archivo estable restaurado.');
      
      res.status(422).json({
        error: 'Error de compilación en el código generado por la IA.',
        details: 'El código propuesto rompió el compilador TypeScript del backend. Se ha activado la auto-reversión de seguridad y el panel ha sido restaurado a su versión anterior estable de inmediato. Por favor, sé más descriptivo en tus instrucciones.',
        buildMessage: String(buildError)
      });
    }

  } catch (err: any) {
    console.error('[Optimization Agent ERROR] Error general en el pipeline:', err.message);
    // Intentamos restaurar en caso de cualquier error intermedio
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, targetPath);
      console.log('[Optimization Agent] Rollback de seguridad por excepción completado.');
    }
    res.status(500).json({ error: 'Error interno en el agente de optimización.', details: err.message });
  }
});

export default router;
