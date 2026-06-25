const fs = require('fs');

const logPath = 'C:\\\\Users\\\\rueda\\\\.gemini\\\\antigravity\\\\brain\\\\0a9386d2-e51d-4510-baeb-67219fc507c0\\.system_generated\\logs\\transcript_full.jsonl';
const outputPath = 'e:\\\\APPS\\\\Receptia - v2\\\\success_matches.txt';

async function run() {
  if (!fs.existsSync(logPath)) {
    console.error('Log file does not exist.');
    return;
  }

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');

  let output = '=== MATCHES ===\n';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const str = JSON.stringify(obj);
      if (str.includes('SUCCESS') || str.includes('exito') || str.includes('correcta')) {
        if (obj.source === 'SYSTEM' || obj.type === 'RUN_COMMAND') {
          output += `\nLine ${i + 1} (step ${obj.step_index}, source=${obj.source}):\n`;
          output += `${obj.content.substring(0, 500)}\n`;
        }
      }
    } catch (e) {}
  }
  
  fs.writeFileSync(outputPath, output);
  console.log(`Saved matches to ${outputPath}`);
}

run();
