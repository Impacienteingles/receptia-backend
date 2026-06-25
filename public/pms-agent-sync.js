/**
 * Receptia - PMS Desktop Sync Agent (Template)
 * 
 * Este script simula un agente local que se ejecuta en el servidor de la clínica
 * para extraer disponibilidad/citas de la base de datos de Gesden o Dentrix y
 * sincronizarla con el servidor de Receptia en la nube.
 * 
 * Uso:
 *   node pms-agent-sync.js --token=<pms_sync_token> --type=<database_type> --url=<receptia_url>
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Parsear argumentos de la línea de comandos
const args = {};
process.argv.slice(2).forEach(val => {
  const parts = val.split('=');
  if (parts.length === 2 && parts[0].startsWith('--')) {
    args[parts[0].substring(2)] = parts[1];
  }
});

const token = args.token || process.env.PMS_SYNC_TOKEN;
const dbType = args.type || 'gesden'; // 'gesden', 'dentrix', etc.
const receptiaUrl = args.url || 'https://corandar.onrender.com';

if (!token) {
  console.error('❌ ERROR: Debe proporcionar un token de sincronización (--token=tu_token_pms).');
  console.log('Puedes obtener tu token desde el panel de Receptia > Ajustes > Integración PMS.');
  process.exit(1);
}

console.log('🏁 Iniciando Agente de Sincronización PMS local...');
console.log(`🔹 Tipo de base de datos local: ${dbType}`);
console.log(`🔹 URL de destino: ${receptiaUrl}`);

// Simulación de lectura de datos de Gesden / Dentrix local
function extractLocalData() {
  console.log('🔍 Extrayendo datos de la base de datos local...');
  
  // En una implementación real, aquí se conectaría a SQL Server (Gesden) o MySQL/Oracle (Dentrix)
  // ej: SELECT * FROM citas WHERE fecha >= hoy;
  
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];

  return {
    database_type: dbType,
    appointments: [
      {
        patient_name: 'Ana García (Sincronizado)',
        patient_phone: '+34611222333',
        patient_email: 'ana.garcia@gmail.com',
        date_time: `${dateStr}T10:00:00Z`,
        specialty: 'Odontología',
        status: 'confirmed'
      },
      {
        patient_name: 'Roberto Gómez (Sincronizado)',
        patient_phone: '+34699887766',
        patient_email: 'roberto@outlook.com',
        date_time: `${dateStr}T11:30:00Z`,
        specialty: 'Pediatría',
        status: 'confirmed'
      }
    ],
    slots: [
      '09:00', '09:30', '10:30', '11:00', '12:00'
    ]
  };
}

// Envío seguro mediante HTTPS/HTTP
function syncWithCloud(payload) {
  const parsedUrl = new URL(`${receptiaUrl}/api/integrations/pms/sync`);
  const data = JSON.stringify(payload);

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      'Authorization': `Bearer ${token}`
    }
  };

  const clientModule = parsedUrl.protocol === 'https:' ? https : http;

  const req = clientModule.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      if (res.statusCode === 200) {
        try {
          const parsed = JSON.parse(body);
          console.log(`✅ ¡Sincronización Exitosa! Servidor respondió: ${parsed.message}`);
          console.log(`   Hora del último sync: ${parsed.last_sync}`);
        } catch (e) {
          console.log('✅ Sincronización Exitosa (respuesta no JSON):', body);
        }
      } else {
        console.error(`❌ Error en el servidor (${res.statusCode}):`, body);
      }
    });
  });

  req.on('error', (e) => {
    console.error('❌ Error de conexión al sincronizar:', e.message);
  });

  req.write(data);
  req.end();
}

// Ejecutar sincronización inicial
const payload = extractLocalData();
syncWithCloud(payload);
