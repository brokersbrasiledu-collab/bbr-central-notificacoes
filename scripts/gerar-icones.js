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

// ── 1. Arquivos que vão como estão ──────────────────────────────
// Só os formatos de aba do navegador. O .ico e o .svg podem ter
// transparência sem problema: ali ela se mistura com a cor da aba.

const COPIAR = [
  ['favicon.ico', 'favicon.ico'],
  ['favicon.svg', 'favicon.svg'],
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
  console.log(`  ✓ ${destino.padEnd(24)} ${kb.padStart(7)} kB  (copiado)`);
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

/**
 * Todos os ícones de aplicativo são gerados aqui, e todos são quadrados
 * OPACOS, preenchendo a arte até a borda.
 *
 * Isso não é preciosismo: a arte original é retangular (433×520), então
 * encaixá-la num quadrado deixa faixas transparentes nas laterais. O iOS
 * pinta transparência de branco antes de aplicar o recorte arredondado —
 * o resultado é um ícone com bordas brancas na tela inicial.
 */
const DERIVADOS = [
  ['apple-touch-icon.png', () => montar(180, 0.76, true)],
  ['icone-192.png', () => montar(192, 0.78, true)],
  ['icone-512.png', () => montar(512, 0.78, true)],
  // 58% deixa a marca dentro da área segura de 80% que o Android exige
  // ao recortar o ícone em círculo ou squircle.
  ['icone-maskable-512.png', () => montar(512, 0.58, true)],
  // Ícone da aba: fundo escuro também, para o dourado ter contraste numa
  // barra de abas clara.
  ['favicon-96.png', () => montar(96, 0.84, true)],
  // Única sem fundo: usada dentro da interface do app.
  ['marca.png', () => montar(256, 1.0, false)],
];

for (const [nome, gerar] of DERIVADOS) {
  const png = gerar();
  fs.writeFileSync(path.join(DESTINO, nome), png);
  console.log(`  ✓ ${nome.padEnd(24)} ${(png.length / 1024).toFixed(1).padStart(7)} kB  (derivado)`);
}

console.log(`\n  Ícones montados em public/icones/\n`);
