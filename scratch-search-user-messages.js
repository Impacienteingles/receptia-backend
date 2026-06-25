const fs = require('fs');

const logPath = 'C:\\\\Users\\\\rueda\\\\.gemini\\\\antigravity\\\\brain\\\\0a9386d2-e51d-4510-baeb-67219fc507c0\\.system_generated\\logs\\transcript_full.jsonl';

async function run() {
  if (!fs.existsSync(logPath)) {
    console.error('Log file does not exist.');
    return;
  }

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');

  console.log('Searching user inputs in transcript...');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'USER_INPUT' || obj.source === 'USER_EXPLICIT') {
        console.log(`\nLine ${i + 1} (step ${obj.step_index}):`);
        console.log(obj.content);
      }
    } catch (e) {}
  }
}

run();
