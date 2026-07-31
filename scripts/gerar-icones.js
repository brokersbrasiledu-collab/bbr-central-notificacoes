#!/usr/bin/env node
/**
 * Monta os ícones do PWA em public/icones/.
 *
 * Fontes, todas versionadas em marca/:
 *   marca/favicon/     ícones prontos (favicon.ico, .svg, 96, 180, 192, 512)
 *   marca/logo-bbr.png arte original, usada para o que precisa ser derivado
 *
 * O que é derivado aqui, e por quê:
 *   • maskable — o Android recorta o ícone num círculo ou squircle. Ele
 *     precisa da marca menor, dentro da área segura, senão as pontas das
 *     asas somem no recorte.
 *   • marca.png — versão sem fundo, usada dentro da interface do app.
 *
 *   npm run icones
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerPNG, escreverPNG, redimensionar, compor, tela, luz } from './lib/png.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAVICONS = path.join(RAIZ, 'marca', 'favicon');
const LOGO = path.join(RAIZ, 'marca', 'logo-bbr.png');
const DESTINO = path.join(RAIZ, 'public', 'icones');

const PRETO = [0x14, 0x14, 0x14];

fs.mkdirSync(DESTINO, { recursive: true });

// ── 1. Ícones prontos, copiados como estão ──────────────────────

const COPIAR = [
  ['favicon.ico', 'favicon.ico'],
  ['favicon.svg', 'favicon.svg'],
  ['favicon-96x96.png', 'favicon-96.png'],
  ['apple-touch-icon.png', 'apple-touch-icon.png'],
  ['web-app-manifest-192x192.png', 'icone-192.png'],
  ['web-app-manifest-512x512.png', 'icone-512.png'],
];

console.log();
for (const [origem, destino] of COPIAR) {
  const de = path.join(FAVICONS, origem);
  if (!fs.existsSync(de)) {
    console.error(`  ✗ faltando: marca/favicon/${origem}`);
    process.exit(1);
  }
  fs.copyFileSync(de, path.join(DESTINO, destino));
  const kb = (fs.statSync(de).size / 1024).toFixed(1);
  console.log(`  ✓ ${destino.padEnd(24)} ${kb.padStart(7)} kB  (da pasta marca/favicon)`);
}

// ── 2. Recorta o emblema da arte original ───────────────────────
// O fundo é quase preto e o traço é dourado, então o brilho separa os
// dois. Os limiares vieram do histograma do arquivo: o fundo vai até
// ~49 e o traço começa perto de 160, sobrando um vale limpo no meio.

const original = lerPNG(fs.readFileSync(LOGO));
const LIMIAR = 80;
const PISO = 52;
const TETO = 150;

let minX = original.largura;
let minY = original.altura;
let maxX = -1;
let maxY = -1;

for (let y = 0; y < original.altura; y++) {
  for (let x = 0; x < original.largura; x++) {
    const i = (y * original.largura + x) * 4;
    if (luz(original.rgba[i], original.rgba[i + 1], original.rgba[i + 2]) > LIMIAR) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

const largura = maxX - minX + 1;
const altura = maxY - minY + 1;

// O fundo escuro vira transparência pelo brilho do pixel: a marca passa
// a pousar em qualquer cor sem retângulo aparente em volta.
const emblema = { largura, altura, rgba: Buffer.alloc(largura * altura * 4) };

for (let y = 0; y < altura; y++) {
  for (let x = 0; x < largura; x++) {
    const o = ((y + minY) * original.largura + (x + minX)) * 4;
    const d = (y * largura + x) * 4;
    const l = luz(original.rgba[o], original.rgba[o + 1], original.rgba[o + 2]);
    emblema.rgba[d] = original.rgba[o];
    emblema.rgba[d + 1] = original.rgba[o + 1];
    emblema.rgba[d + 2] = original.rgba[o + 2];
    emblema.rgba[d + 3] = Math.round(Math.max(0, Math.min(1, (l - PISO) / (TETO - PISO))) * 255);
  }
}

// ── 3. Derivados ────────────────────────────────────────────────

function montar(lado, ocupacao, comFundo) {
  const base = tela(lado, lado, comFundo ? PRETO : null);
  const escala = Math.min((lado * ocupacao) / largura, (lado * ocupacao) / altura);
  const l = Math.max(1, Math.round(largura * escala));
  const a = Math.max(1, Math.round(altura * escala));
  compor(base, redimensionar(emblema, l, a), Math.round((lado - l) / 2), Math.round((lado - a) / 2));
  return escreverPNG(lado, lado, base.rgba);
}

const DERIVADOS = [
  // 58% deixa a marca dentro da área segura de 80% que o Android exige.
  ['icone-maskable-512.png', () => montar(512, 0.58, true)],
  // Sem fundo, para a interface do app.
  ['marca.png', () => montar(256, 1.0, false)],
];

for (const [nome, gerar] of DERIVADOS) {
  const png = gerar();
  fs.writeFileSync(path.join(DESTINO, nome), png);
  console.log(`  ✓ ${nome.padEnd(24)} ${(png.length / 1024).toFixed(1).padStart(7)} kB  (derivado)`);
}

console.log(`\n  Ícones montados em public/icones/\n`);
