const fs = require('fs');
const readline = require('readline');
const path = 'C:\\Users\\rueda\\.gemini\\antigravity\\brain\\0a9386d2-e51d-4510-baeb-67219fc507c0\\.system_generated\\logs\\transcript.jsonl';

async function readLine() {
  const fileStream = fs.createReadStream(path);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let lineCount = 0;
  for await (const line of rl) {
    lineCount++;
    if (lineCount === 6304) {
      try {
        const obj = JSON.parse(line);
        console.log(`=== LINE ${lineCount} ===`);
        console.log(obj.content);
        break;
      } catch (e) {
        console.log(`Error parsing line 6304: ${e.message}`);
      }
    }
  }
}

readLine().catch(console.error);
