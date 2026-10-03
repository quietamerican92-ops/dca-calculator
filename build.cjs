// Assembles the deployable site in dist/: the simulator page plus PWA files from web/.
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('dca_model.html', path.join('dist', 'index.html'));
for (const f of fs.readdirSync('web')) fs.copyFileSync(path.join('web', f), path.join('dist', f));
fs.writeFileSync(path.join('dist', '.nojekyll'), '');
console.log('built dist/');
