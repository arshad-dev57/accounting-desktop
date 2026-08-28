const src = require('fs').readFileSync('src/renderer/sell.js', 'utf8');
const lines = src.split('\n');
let stack = [];
let inStr = null, esc = false, inComment = null;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const ch = line[j], next = line[j + 1];
    if (inComment === 'line') break;
    if (inComment === 'block') { if (ch === '*' && next === '/') { inComment = null; j++; } continue; }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }

    if (ch === '/' && next === '/') { inComment = 'line'; continue; }
    if (ch === '/' && next === '*') { inComment = 'block'; j++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') stack.push(i + 1);
    if (ch === '}') stack.pop();
  }
}
console.log('unclosed { at lines:', stack);
for (const l of stack) console.log('L' + l + ':', lines[l - 1].trim().slice(0, 80));
