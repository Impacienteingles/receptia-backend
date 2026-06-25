const fs = require('fs');

const logPath = 'C:\\\\Users\\\\rueda\\\\.gemini\\\\antigravity\\\\brain\\\\0a9386d2-e51d-4510-baeb-67219fc507c0\\.system_generated\\logs\\transcript_full.jsonl';

async function run() {
  if (!fs.existsSync(logPath)) {
    console.error('Log file does not exist.');
    return;
  }

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');

  console.log('Searching older success messages...');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.step_index && obj.step_index < 5000) {
        const str = JSON.stringify(obj);
        if (str.includes('SUCCESS') || str.includes('exito') || str.includes('correctamente') || str.includes('exitosamente')) {
          // Only log if it comes from SYSTEM or RUN_COMMAND
          if (obj.source === 'SYSTEM' || obj.type === 'RUN_COMMAND') {
            console.log(`\nLine ${i + 1} (step ${obj.step_index}, source=${obj.source}):`);
            console.log(obj.content.substring(0, 1000));
          }
        }
      }
    } catch (e) {}
  }
}

run();
