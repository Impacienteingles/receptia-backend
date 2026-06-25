const fs = require('fs');

const logPath = 'C:\\\\Users\\\\rueda\\\\.gemini\\\\antigravity\\\\brain\\\\0a9386d2-e51d-4510-baeb-67219fc507c0\\.system_generated\\logs\\transcript_full.jsonl';

async function run() {
  if (!fs.existsSync(logPath)) {
    console.error('Log file does not exist.');
    return;
  }

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');

  console.log('Searching all SUCCESS occurrences...');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const str = JSON.stringify(obj);
      if (str.includes('SUCCESS') || str.includes('exito')) {
        console.log(`\nLine ${i + 1} (step ${obj.step_index}, source=${obj.source}):`);
        console.log(str.substring(0, 500));
      }
    } catch (e) {}
  }
}

run();
