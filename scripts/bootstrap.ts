import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { setupAgent } from './setup-agent';

// Cargar variables de entorno
dotenv.config();

const ENV_PATH = path.join(process.cwd(), '.env');

/**
 * Modifica el archivo .env reemplazando una clave existente o añadiéndola.
 */
function updateEnvVariable(key: string, value: string) {
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, `${key}=${value}\n`);
    return;
  }

  let envContent = fs.readFileSync(ENV_PATH, 'utf-8');
  const regex = new RegExp(`^${key}=.*$`, 'm');

  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `${key}=${value}`);
  } else {
    envContent += `\n${key}=${value}`;
  }

  fs.writeFileSync(ENV_PATH, envContent);
}

async function bootstrap() {
  console.log('🚀 Iniciando el proceso de orquestación (Bootstrap) con localtunnel...');

  // 1. Levantar localtunnel
  console.log('📡 Solicitando túnel público gratuito en puerto 3000 con localtunnel...');
  const ltProcess = spawn('npx', ['localtunnel', '--port', '3000'], {
    shell: true,
  });

  let webhookUrl = '';
  let phase2Triggered = false;

  ltProcess.stdout.on('data', async (data) => {
    const output = data.toString();
    console.log(`[localtunnel] ${output.trim()}`);

    // Buscar el patrón "your url is: https://..."
    const match = output.match(/your url is:\s+(https:\/\/[^\s]+)/i);
    if (match && !phase2Triggered) {
      phase2Triggered = true;
      webhookUrl = match[1];
      
      console.log(`✅ ¡Túnel establecido exitosamente!: ${webhookUrl}`);
      
      // Actualizar .env con el webhook
      updateEnvVariable('WEBHOOK_BASE_URL', webhookUrl);

      // 2. Configurar Retell AI
      let agentId = '';
      try {
        console.log('\n🤖 Creando y configurando el agente de voz en Retell AI...');
        agentId = await setupAgent(webhookUrl);
        
        // Guardar el agentId en .env
        updateEnvVariable('RETELL_AGENT_ID', agentId);
        console.log(`💾 Archivo .env actualizado con RETELL_AGENT_ID=${agentId}`);
      } catch (error: any) {
        console.error('❌ Error al configurar el agente en Retell:', error.message);
      }

      // 3. Levantar Express Server usando el código compilado en dist/ para máxima velocidad
      console.log('\n🖥️  Iniciando el servidor Express de backend (dist/index.js)...');
      const expressProcess = spawn('node', ['dist/index.js'], {
        shell: true,
      });

      expressProcess.stdout.on('data', (expressData) => {
        console.log(`[express] ${expressData.toString().trim()}`);
      });

      expressProcess.stderr.on('data', (expressError) => {
        console.error(`[express-error] ${expressError.toString().trim()}`);
      });

      expressProcess.on('close', (code) => {
        console.log(`[express] Proceso Express cerrado con código ${code}`);
      });

      // Esperar un par de segundos para confirmar que Express arrancó bien
      setTimeout(() => {
        console.log('\n🎉 ==================================================== 🎉');
        console.log('  ¡TODO EL SISTEMA HA SIDO CONFIGURADO Y ESTÁ CORRIENDO!');
        console.log('========================================================');
        if (agentId) {
          console.log(`  🔹 Agente Retell ID: ${agentId}`);
        }
        console.log(`  🔹 Webhook Activo: ${webhookUrl}`);
        console.log(`\n  👉 AHORA HAZ CLIC AQUÍ PARA VINCULAR TU CALENDAR:`);
        console.log(`     http://localhost:3000/auth`);
        console.log('========================================================\n');
      }, 3000);
    }
  });

  ltProcess.stderr.on('data', (data) => {
    console.error(`[localtunnel-error] ${data.toString().trim()}`);
  });

  ltProcess.on('close', (code) => {
    console.log(`[localtunnel] Proceso cerrado con código ${code}`);
  });
}

bootstrap();
