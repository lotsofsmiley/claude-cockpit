'use strict';
/*
 * Rasterize app/assets/icon.svg into icon.png (256) and a multi-resolution icon.ico
 * (16–256). Run after editing icon.svg:  node scripts/gen-icons.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const _pti = require('png-to-ico');
const pngToIco = _pti.default || _pti;

const ASSETS = path.join(__dirname, '..', 'app', 'assets');
const svg = fs.readFileSync(path.join(ASSETS, 'icon.svg'));
const sizes = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  await sharp(svg, { density: 384 }).resize(256, 256).png().toFile(path.join(ASSETS, 'icon.png'));
  const bufs = [];
  for (const s of sizes) bufs.push(await sharp(svg, { density: 384 }).resize(s, s).png().toBuffer());
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), await pngToIco(bufs));
  console.log('wrote icon.png + icon.ico [' + sizes.join(', ') + ']');
})().catch((e) => { console.error(e); process.exit(1); });
