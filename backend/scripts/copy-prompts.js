// tsc only emits .js, so the prompt texts (src/prompts/**/*.md) are copied into dist/prompts
// here. Stale .md files are removed first, so a prompt deleted from src cannot linger in a build.
const fs = require('fs');
const path = require('path');

const src  = path.join(__dirname, '..', 'src', 'prompts');
const dest = path.join(__dirname, '..', 'dist', 'prompts');

const walk = (dir, onFile) => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
};

walk(dest, file => { if (file.endsWith('.md')) fs.rmSync(file); });

let count = 0;
walk(src, file => {
  if (!file.endsWith('.md')) return;
  const target = path.join(dest, path.relative(src, file));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  count++;
});

console.log(`[copy-prompts] ${count} prompt file(s) -> dist/prompts`);
