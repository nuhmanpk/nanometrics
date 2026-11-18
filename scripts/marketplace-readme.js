// The Marketplace rejects SVG images in the README, so the packaged copy swaps in PNGs.
// GitHub keeps the animated SVG README.md. Images without a PNG twin are dropped from the copy.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const lines = fs.readFileSync(path.join(root, 'README.md'), 'utf8').split('\n');
const out = [];
for (const line of lines) {
    if (!/\.svg/.test(line) || !/images\//.test(line)) {
        out.push(line);
        continue;
    }
    const png = line.replace(/images\/([\w-]+)\.svg/g, 'images/$1.png');
    const files = [...png.matchAll(/images\/([\w-]+\.png)/g)].map(m => m[1]);
    // Keep the line only when every PNG it names exists; otherwise drop it.
    if (files.every(f => fs.existsSync(path.join(root, 'images', f)))) {
        out.push(png);
    }
}
fs.writeFileSync(path.join(root, 'README.marketplace.md'), out.join('\n'));
console.log('wrote README.marketplace.md');
