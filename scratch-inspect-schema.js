const https = require('https');
require('dotenv').config();

const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const hostname = SUPABASE_URL.replace('https://', '');

const options = {
  hostname,
  path: '/rest/v1/',
  method: 'GET',
  headers: {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Accept': 'application/json'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const schema = JSON.parse(data);
      console.log('=== Schema definitions found ===');
      
      const tables = ['tenants', 'prospects', 'call_logs'];
      for (const table of tables) {
        const definition = schema.definitions ? schema.definitions[table] : null;
        if (definition) {
          console.log(`\nTable [${table}] Columns:`);
          const properties = definition.properties;
          for (const col in properties) {
            const prop = properties[col];
            console.log(` - ${col} (${prop.type})`);
          }
        } else {
          console.log(`Definition for table ${table} not found.`);
        }
      }
    } catch (e) {
      console.error('Failed to parse response:', e.message);
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
});

req.end();
