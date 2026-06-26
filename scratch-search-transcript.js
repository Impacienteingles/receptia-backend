const fs = require('fs');
const path = require('path');

const logPath = 'C:\\Users\\rueda\\.gemini\\antigravity\\brain\\0a9386d2-e51d-4510-baeb-67219fc507c0\\.system_generated\\logs\\transcript.jsonl';

if (!fs.existsSync(logPath)) {
  console.log('Log file not found at:', logPath);
  process.exit(1);
}

const content = fs.readFileSync(logPath, 'utf-8');
const lines = content.split('\n');

console.log('Searching for Fase 2/Phase 2 in transcript...');
lines.forEach((line, idx) => {
  if (line.toLowerCase().includes('fase 2') || line.toLowerCase().includes('phase 2')) {
    console.log(`\n--- Line ${idx+1} ---`);
    try {
      const parsed = JSON.parse(line);
      console.log('Source:', parsed.source);
      console.log('Type:', parsed.type);
      console.log('Content snippet:', parsed.content ? parsed.content.substring(0, 800) : 'none');
    } catch (e) {
      console.log('Raw line preview:', line.substring(0, 500));
    }
  }
});
