import axios from 'axios';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { setupAgent } from './setup-agent';

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RETELL_API_KEY = process.env.RETELL_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GITHUB_TOKEN || !RENDER_API_KEY || !RETELL_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ ERROR: Faltan variables de entorno esenciales en el archivo .env (GITHUB_TOKEN, RENDER_API_KEY, RETELL_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}

async function runDeploy() {
  console.log('🏁 Iniciando proceso de despliegue seguro y silencioso...');

  // 0. Obtener el usuario de GitHub asociado al token
  let githubUser = '';
  try {
    console.log('🔍 Identificando usuario de GitHub asociado al token...');
    const userRes = await axios.get('https://api.github.com/user', {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    githubUser = userRes.data.login;
    console.log(`✅ Usuario de GitHub identificado: ${githubUser}`);
  } catch (error: any) {
    console.error('❌ Error al identificar el usuario de GitHub (token inválido o revocado):', error.message);
    process.exit(1);
  }

  // 1. Crear/Configurar repositorio en GitHub como Público
  console.log('\n1. Creando o configurando repositorio público en GitHub...');
  try {
    await axios.post(
      'https://api.github.com/user/repos',
      {
        name: 'receptia-backend',
        private: false,
        description: 'Backend para Agente de Voz de Clínica Médica SanaSalud',
      },
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );
    console.log('✅ Repositorio receptia-backend creado con éxito en GitHub.');
  } catch (error: any) {
    if (error.response && error.response.status === 422) {
      console.log('ℹ️ El repositorio ya existe en tu cuenta de GitHub. Asegurando que sea público...');
      try {
        await axios.patch(
          `https://api.github.com/repos/${githubUser}/receptia-backend`,
          { private: false },
          {
            headers: {
              Authorization: `token ${GITHUB_TOKEN}`,
              Accept: 'application/vnd.github.v3+json',
            },
          }
        );
        console.log('✅ Repositorio configurado como público.');
      } catch (patchError: any) {
        console.log('⚠️ No se pudo cambiar la visibilidad del repositorio (puede que ya sea público):', patchError.message);
      }
    } else {
      console.error('❌ Error al crear repositorio en GitHub:', error.message);
      process.exit(1);
    }
  }

  // 2. Ejecutar comandos de Git locales de forma silenciosa (para no exponer el token)
  console.log('\n2. Inicializando Git local y subiendo el código a GitHub...');
  try {
    // Inicializar git silenciosamente
    execSync('git init', { stdio: 'ignore' });
    execSync('git config user.name "yoyrenfe"', { stdio: 'ignore' });
    execSync('git config user.email "yoyrenfe@gmail.com"', { stdio: 'ignore' });
    execSync('git add .', { stdio: 'ignore' });
    
    // Asegurarse de que token.json, credentials.json y .env no se suban al repo público
    try {
      execSync('git rm --cached token.json credentials.json .env', { stdio: 'ignore' });
      console.log('🛡️ token.json, credentials.json y .env excluidos de la caché de Git por seguridad.');
    } catch (e) {}

    // Crear commit
    try {
      execSync('git commit -m "Deploy limpio en repositorio público"', { stdio: 'ignore' });
    } catch (e) {
      // Ignorar si no hay cambios
    }
    
    execSync('git branch -M main', { stdio: 'ignore' });
    
    // Configurar remote con credenciales incrustadas de forma oculta
    try {
      execSync('git remote remove origin', { stdio: 'ignore' });
    } catch (e) {}
    
    execSync(
      `git remote add origin https://${GITHUB_TOKEN}@github.com/${githubUser}/receptia-backend.git`,
      { stdio: 'ignore' }
    );
    
    console.log('⬆️ Empujando código a GitHub de forma segura (silenciando consola)...');
    execSync('git push -u origin main -f', { stdio: 'ignore' });
    console.log('✅ Código empujado a GitHub con éxito.');

    // Limpiar el remote después del push para mayor seguridad
    try {
      execSync('git remote remove origin', { stdio: 'ignore' });
    } catch (e) {}
  } catch (error: any) {
    console.error('❌ Error durante los comandos de Git. El push falló.');
    process.exit(1);
  }

  // 3. Crear servicio en Render
  console.log('\n3. Creando el servicio en Render...');
  try {
    const renderClient = axios.create({
      baseURL: 'https://api.render.com/v1',
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    // A. Obtener el Owner ID
    console.log('🔍 Obteniendo Owner ID de Render...');
    const ownersRes = await renderClient.get('/owners');
    const ownerId = ownersRes.data[0]?.owner?.id;
    if (!ownerId) {
      throw new Error('No se pudo encontrar un Owner ID en tu cuenta de Render.');
    }
    console.log(`✅ Owner ID encontrado: ${ownerId}`);

    // B. Crear el servicio
    console.log('🚀 Creando Web Service en Render...');
    const servicePayload = {
      type: 'web_service',
      name: 'corandar',
      ownerId: ownerId,
      repo: `https://github.com/${githubUser}/receptia-backend`,
      branch: 'main',
      autoDeploy: 'yes',
      serviceDetails: {
        env: 'node',
        plan: 'free',
        region: 'oregon',
        envSpecificDetails: {
          buildCommand: 'npm install --include=dev && npm run build',
          startCommand: 'npm start',
        },
        envVars: [
          { key: 'PORT', value: '3000' },
          { key: 'RETELL_API_KEY', value: RETELL_API_KEY },
          { key: 'GOOGLE_CLIENT_ID', value: '624764332114-fa1l7t3tn1bmlj02nic97430b3biov97.apps.googleusercontent.com' },
          { key: 'GOOGLE_CLIENT_SECRET', value: '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' },
          { key: 'GOOGLE_REDIRECT_URI', value: 'PENDING' },
          { key: 'SUPABASE_URL', value: SUPABASE_URL },
          { key: 'SUPABASE_SERVICE_ROLE_KEY', value: SUPABASE_SERVICE_ROLE_KEY },
        ],
      },
    };

    let serviceUrl = '';
    let serviceId = '';
    try {
      const serviceRes = await renderClient.post('/services', servicePayload);
      serviceId = serviceRes.data.service?.id || serviceRes.data.id;
      serviceUrl = serviceRes.data.service?.serviceDetails?.url || serviceRes.data.serviceDetails?.url;
      console.log(`✅ Web Service creado en Render de forma exitosa con ID: ${serviceId}.`);
    } catch (createError: any) {
      const isAlreadyInUse = 
        createError.response && 
        (createError.response.status === 409 || 
         (createError.response.status === 400 && 
          JSON.stringify(createError.response.data).includes('already in use')));

      if (isAlreadyInUse) {
        console.log('ℹ️ El servicio ya existe en Render. Obteniendo información...');
        const servicesList = await renderClient.get('/services');
        const existingService = servicesList.data.find((s: any) => s.service.name === 'corandar');
        if (existingService) {
          serviceId = existingService.service.id;
          serviceUrl = existingService.service.serviceDetails?.url || existingService.service?.url;
          console.log(`✅ Servicio existente encontrado con ID: ${serviceId}.`);
        } else {
          throw createError;
        }
      } else {
        throw createError;
      }
    }

    console.log(`🔗 URL de producción en Render: ${serviceUrl}`);

    // Sincronizar las variables de entorno con la URL final real
    console.log('⚙️ Sincronizando variables de entorno en Render con la URL final...');
    const envVars = [
      { key: 'PORT', value: '3000' },
      { key: 'RETELL_API_KEY', value: RETELL_API_KEY },
      { key: 'GOOGLE_CLIENT_ID', value: '624764332114-fa1l7t3tn1bmlj02nic97430b3biov97.apps.googleusercontent.com' },
      { key: 'GOOGLE_CLIENT_SECRET', value: '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' },
      { key: 'GOOGLE_REDIRECT_URI', value: `${serviceUrl}/oauth2callback` },
      { key: 'SUPABASE_URL', value: SUPABASE_URL },
      { key: 'SUPABASE_SERVICE_ROLE_KEY', value: SUPABASE_SERVICE_ROLE_KEY },
    ];

    if (process.env.SMTP_HOST) envVars.push({ key: 'SMTP_HOST', value: process.env.SMTP_HOST });
    if (process.env.SMTP_PORT) envVars.push({ key: 'SMTP_PORT', value: process.env.SMTP_PORT });
    if (process.env.SMTP_SECURE) envVars.push({ key: 'SMTP_SECURE', value: process.env.SMTP_SECURE });
    if (process.env.SMTP_USER) envVars.push({ key: 'SMTP_USER', value: process.env.SMTP_USER });
    if (process.env.SMTP_PASS) envVars.push({ key: 'SMTP_PASS', value: process.env.SMTP_PASS });
    if (process.env.CONTACT_RECEIVER_EMAIL) envVars.push({ key: 'CONTACT_RECEIVER_EMAIL', value: process.env.CONTACT_RECEIVER_EMAIL });

    await renderClient.put(`/services/${serviceId}/env-vars`, envVars);
    console.log('✅ Variables de entorno actualizadas.');

    // Forzar un nuevo despliegue con la última versión del código y env vars
    console.log('🔄 Disparando un nuevo despliegue (deploy) en Render...');
    await renderClient.post(`/services/${serviceId}/deploys`, {
      clearCache: 'clear'
    });
    console.log('✅ Despliegue disparado exitosamente.');

    // 4. Configurar Retell AI con la URL de producción
    console.log('\n4. Configurando el Agente de Retell AI con la URL de Render...');
    const agentId = await setupAgent(serviceUrl);
    console.log(`✅ Agente de voz registrado exitosamente en Retell AI con ID: ${agentId}`);

    console.log('\n🎉 ==================================================== 🎉');
    console.log('  ¡EL DESPLIEGUE SE COMPLETO Y EL BACKEND ESTÁ EN LA NUBE!');
    console.log('========================================================');
    console.log(`  🔹 Agente Retell ID: ${agentId}`);
    console.log(`  🔹 URL Webhook Render: ${serviceUrl}`);
    console.log(`\n  👉 Render está compilando y desplegando el código.`);
    console.log('  Tardará entre 2 y 3 minutos en estar completamente activo.');
    console.log('  Una vez que termine, visita este enlace para vincular');
    console.log('  tu Google Calendar en la nube:');
    console.log(`  👉 ${serviceUrl}/auth`);
    console.log('========================================================\n');
  } catch (error: any) {
    console.error('\n❌ ERROR DURANTE EL DESPLIEGUE EN RENDER:');
    if (error.response) {
      console.error(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }
}

runDeploy();
