const fs = require('fs');
const path = require('path');

const logsDir = 'C:\\Users\\rueda\\.gemini\\antigravity\\brain\\e7b84919-f0a2-4c2c-99aa-1a1a9e87a351\\.system_generated\\logs';

if (!fs.existsSync(logsDir)) {
  console.log('Logs dir does not exist.');
  process.exit(1);
}

const files = fs.readdirSync(logsDir);
for (const file of files) {
  if (file.endsWith('.jsonl') || file.endsWith('.log')) {
    const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
    if (content.includes('CONEXIÓN EXITOSA') || content.includes('SUCCESS WITH PASSWORD') || content.includes('success with password')) {
      console.log(`Found match in file: ${file}`);
      const lines = content.split('\n');
      for (const line of lines) {
        if ((line.includes('CONEXIÓN EXITOSA') || line.includes('SUCCESS WITH') || line.includes('success with')) && !line.includes('"VIEW_FILE"') && !line.includes('"PLANNER_RESPONSE"')) {
          console.log('  -->', line);
        }
      }
    }
  }
}
