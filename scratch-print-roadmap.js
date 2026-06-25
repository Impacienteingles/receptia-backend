const fs = require('fs');
const path = require('path');

const logPath = 'C:\\Users\\rueda\\.gemini\\antigravity\\brain\\0a9386d2-e51d-4510-baeb-67219fc507c0\\.system_generated\\logs\\transcript.jsonl';

if (!fs.existsSync(logPath)) {
  console.log('Log file not found at:', logPath);
  process.exit(1);
}

const content = fs.readFileSync(logPath, 'utf-8');
const lines = content.split('\n');

// Find the line that starts the roadmap
const targetLineIndex = 8879; // Line 8880 (0-indexed)
console.log('--- Printing around line 8880 ---');

for (let i = targetLineIndex; i < targetLineIndex + 50 && i < lines.length; i++) {
  try {
    const parsed = JSON.parse(lines[i]);
    if (parsed.content) {
      console.log(`\n=== STEP ${i+1} (${parsed.type}) ===`);
      console.log(parsed.content);
    }
  } catch (e) {
    console.log(`Raw line ${i+1}:`, lines[i].substring(0, 300));
  }
}
