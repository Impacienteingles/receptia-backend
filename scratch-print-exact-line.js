const fs = require('fs');
const logPath = 'C:\\Users\\rueda\\.gemini\\antigravity\\brain\\0a9386d2-e51d-4510-baeb-67219fc507c0\\.system_generated\\logs\\transcript.jsonl';

const content = fs.readFileSync(logPath, 'utf-8');
const lines = content.split('\n');

// Let's print line 8880 (index 8879)
console.log('=== Line 8880 Content ===');
try {
  const parsed = JSON.parse(lines[8879]);
  console.log('Type:', parsed.type);
  console.log('Content:\n', parsed.content);
} catch (e) {
  console.log('Raw:\n', lines[8879]);
}
