#!/usr/bin/env node
/**
 * Gera todos os ícones do PWA a partir da logo oficial em marca/logo-bbr.png.
 *
 * O que ele faz:
 *   1. Lê a logo e encontra o emblema dentro dela (a arte original vem com
 *      sobra de fundo em volta, que precisa sair para o ícone não ficar
 *      pequeno demais na tela inicial).
 *   2. Recorta o fundo escuro transformando-o em transparência, pelo brilho
 *      de cada pixel. Assim a marca pousa em qualquer fundo sem emenda.
 *   3. Redimensiona por média de área e monta cada tamanho pedido.
 *
 *   npm run icones
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerPNG, escreverPNG, redimensionar, compor, tela, luz } from './lib/png.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGEM = path.join(RAIZ, 'marca', 'logo-bbr.png');
const DESTINO = path.join(RAIZ, 'public', 'icones');

const PRETO = [0x14, 0x14, 0x14];

if (!fs.existsSync(ORIGEM)) {
  console.error(`\n  Não encontrei a logo em marca/logo-bbr.png\n`);
  process.exit(1);
}

const original = lerPNG(fs.readFileSync(ORIGEM));
console.log(`\n  Logo lida: ${original.largura}×${original.altura}`);

// ── 1. Onde está o emblema ──────────────────────────────────────
// O fundo da arte é quase preto e o emblema é dourado, então o brilho
// separa os dois com folga. Medindo o arquivo original, o fundo (com o
// leve degradê que ele tem) vai até ~49 e o traço começa perto de 160 —
// sobra um vale bem vazio no meio para cortar sem dúvida.
const LIMIAR = 80;

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

if (maxX < 0) {
  console.error('  Não achei o emblema na imagem — o limiar de brilho pode estar alto demais.');
  process.exit(1);
}

const recorte = {
  x: minX,
  y: minY,
  largura: maxX - minX + 1,
  altura: maxY - minY + 1,
};
console.log(
  `  Emblema encontrado: ${recorte.largura}×${recorte.altura} ` +
    `(a partir de ${recorte.x},${recorte.y})`
);

// ── 2. Fundo escuro vira transparência ──────────────────────────
// O brilho do pixel vira o canal alpha. Como o traço é dourado sobre
// quase-preto, isso recorta a marca com a borda suave que ela já tem,
// sem precisar de máscara manual.
const emblema = {
  largura: recorte.largura,
  altura: recorte.altura,
  rgba: Buffer.alloc(recorte.largura * recorte.altura * 4),
};

// Valores tirados do histograma do arquivo original. O piso precisa ficar
// ACIMA do fundo mais claro (~49, no miolo do degradê), senão sobra um
// retângulo fantasma em volta do emblema.
const PISO = 52; // abaixo disto é fundo, vira transparente
const TETO = 150; // acima disto é traço cheio, fica opaco

for (let y = 0; y < recorte.altura; y++) {
  for (let x = 0; x < recorte.largura; x++) {
    const o = ((y + recorte.y) * original.largura + (x + recorte.x)) * 4;
    const d = (y * recorte.largura + x) * 4;
    const l = luz(original.rgba[o], original.rgba[o + 1], original.rgba[o + 2]);

    const alpha = Math.max(0, Math.min(1, (l - PISO) / (TETO - PISO)));
    emblema.rgba[d] = original.rgba[o];
    emblema.rgba[d + 1] = original.rgba[o + 1];
    emblema.rgba[d + 2] = original.rgba[o + 2];
    emblema.rgba[d + 3] = Math.round(alpha * 255);
  }
}

// ── 3. Montagem dos arquivos ────────────────────────────────────

fs.mkdirSync(DESTINO, { recursive: true });

/**
 * Monta um ícone quadrado com o emblema centralizado.
 * @param {number} lado       tamanho final em pixels
 * @param {number} ocupacao   fração do lado que o emblema ocupa
 * @param {boolean} comFundo  true = fundo preto da marca; false = transparente
 */
function montar(lado, ocupacao, comFundo = true) {
  const base = tela(lado, lado, comFundo ? PRETO : null);

  // Mantém a proporção do emblema dentro da área permitida.
  const escala = Math.min(
    (lado * ocupacao) / emblema.largura,
    (lado * ocupacao) / emblema.altura
  );
  const largura = Math.max(1, Math.round(emblema.largura * escala));
  const altura = Math.max(1, Math.round(emblema.altura * escala));

  const reduzido = redimensionar(emblema, largura, altura);
  compor(base, reduzido, Math.round((lado - largura) / 2), Math.round((lado - altura) / 2));

  return escreverPNG(lado, lado, base.rgba);
}

const arquivos = [
  // Ícone comum: o emblema ocupa 78% do quadrado.
  ['icone-192.png', () => montar(192, 0.78)],
  ['icone-512.png', () => montar(512, 0.78)],
  // Maskable: o Android recorta as bordas, então a marca recua para 58%.
  ['icone-maskable-512.png', () => montar(512, 0.58)],
  ['apple-touch-icon.png', () => montar(180, 0.78)],
  // No favicon a marca ganha o quadro inteiro para não sumir a 32px.
  ['favicon-32.png', () => montar(32, 0.92)],
  // Versão sem fundo, usada dentro da interface do app.
  ['marca.png', () => montar(256, 1.0, false)],
];

console.log();
for (const [nome, gerar] of arquivos) {
  const png = gerar();
  fs.writeFileSync(path.join(DESTINO, nome), png);
  console.log(`  ✓ ${nome.padEnd(26)} ${(png.length / 1024).toFixed(1)} kB`);
}

console.log(`\n  Ícones gerados em public/icones/\n`);
