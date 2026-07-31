#!/usr/bin/env node
/**
 * Gera os ícones PNG do PWA sem depender de nenhuma biblioteca gráfica:
 * o PNG é montado à mão (cabeçalho + zlib) e o desenho é rasterizado
 * com supersampling 4×4 para as curvas saírem suaves.
 *
 * Marca: monograma "B" em ouro sobre o preto da Brokers Brasil.
 *
 *   npm run icones
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESTINO = path.join(RAIZ, 'public', 'icones');

const PRETO = [0x14, 0x14, 0x14];
const OURO = [0xb0, 0xa4, 0x73];

// ── Codificador PNG mínimo (RGBA, 8 bits) ───────────────────────

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bloco(tipo, dados) {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, crc]);
}

function codificarPNG(largura, altura, rgba) {
  const assinatura = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // profundidade de bits
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compressão
  ihdr[11] = 0; // filtro
  ihdr[12] = 0; // sem entrelaçamento

  // Cada linha vai precedida do byte de filtro (0 = nenhum).
  const linhas = Buffer.alloc(altura * (largura * 4 + 1));
  for (let y = 0; y < altura; y++) {
    const inicio = y * (largura * 4 + 1);
    linhas[inicio] = 0;
    rgba.copy(linhas, inicio + 1, y * largura * 4, (y + 1) * largura * 4);
  }

  return Buffer.concat([
    assinatura,
    bloco('IHDR', ihdr),
    bloco('IDAT', zlib.deflateSync(linhas, { level: 9 })),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

// ── Desenho do monograma ────────────────────────────────────────

/**
 * Proporção largura/altura da letra. Barrigas circulares deixariam o "B"
 * estreito demais, então elas são elípticas e a largura é escolhida aqui.
 */
const ASPECTO = 0.76;

/**
 * O "B" é montado com geometria: uma haste vertical e dois meios-anéis
 * elípticos à direita. Coordenadas em unidades da altura da letra —
 * y vai de 0 a 1 e x de 0 a ASPECTO.
 */
function dentroDoB(x, y) {
  const ESPESSURA = 0.165;

  // Haste vertical.
  if (x >= 0 && x <= 0.2 && y >= 0 && y <= 1) return true;

  const meioAnel = (cx, cy, rx, ry) => {
    // Começa um pouco antes do centro para emendar na haste sem costura.
    if (x < cx - 0.06) return false;
    const dx = x - cx;
    const dy = y - cy;
    const foraExterno = (dx / rx) ** 2 + (dy / ry) ** 2 > 1;
    if (foraExterno) return false;
    // Vazio interno: o buraco da barriga.
    return (dx / (rx - ESPESSURA)) ** 2 + (dy / (ry - ESPESSURA)) ** 2 >= 1;
  };

  // Barriga de cima (menor) e de baixo (maior), como num "B" tipográfico.
  return meioAnel(0.2, 0.268, 0.5, 0.268) || meioAnel(0.2, 0.736, 0.56, 0.264);
}

/**
 * Rasteriza um ícone quadrado.
 * @param {number} tamanho    lado em pixels
 * @param {number} proporcao  fração do lado ocupada pela letra (área segura)
 */
function desenharIcone(tamanho, proporcao) {
  const rgba = Buffer.alloc(tamanho * tamanho * 4);
  const AMOSTRAS = 4; // supersampling 4×4 → 16 amostras por pixel

  // Caixa da letra, centralizada. A letra é mais alta que larga.
  const alturaLetra = tamanho * proporcao;
  const larguraLetra = alturaLetra * ASPECTO;
  const esquerda = (tamanho - larguraLetra) / 2;
  const topo = (tamanho - alturaLetra) / 2;

  for (let py = 0; py < tamanho; py++) {
    for (let px = 0; px < tamanho; px++) {
      let dentro = 0;
      for (let sy = 0; sy < AMOSTRAS; sy++) {
        for (let sx = 0; sx < AMOSTRAS; sx++) {
          const ax = px + (sx + 0.5) / AMOSTRAS;
          const ay = py + (sy + 0.5) / AMOSTRAS;
          // Mesma escala nos dois eixos: a proporção já está no ASPECTO.
          const nx = (ax - esquerda) / alturaLetra;
          const ny = (ay - topo) / alturaLetra;
          if (nx >= 0 && nx <= ASPECTO && ny >= 0 && ny <= 1 && dentroDoB(nx, ny)) dentro++;
        }
      }

      // Mistura fundo e ouro conforme a cobertura da amostragem.
      const cobertura = dentro / (AMOSTRAS * AMOSTRAS);
      const i = (py * tamanho + px) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(PRETO[c] * (1 - cobertura) + OURO[c] * cobertura);
      }
      rgba[i + 3] = 255;
    }
  }

  return codificarPNG(tamanho, tamanho, rgba);
}

// ── Geração dos arquivos ────────────────────────────────────────

fs.mkdirSync(DESTINO, { recursive: true });

const arquivos = [
  // A letra ocupa 56% do ícone comum e 44% no maskable — o Android
  // recorta as bordas do maskable, então a marca precisa de folga.
  ['icone-192.png', 192, 0.56],
  ['icone-512.png', 512, 0.56],
  ['icone-maskable-512.png', 512, 0.44],
  ['apple-touch-icon.png', 180, 0.56],
  ['favicon-32.png', 32, 0.6],
];

for (const [nome, tamanho, proporcao] of arquivos) {
  const png = desenharIcone(tamanho, proporcao);
  fs.writeFileSync(path.join(DESTINO, nome), png);
  console.log(`  ✓ ${nome.padEnd(26)} ${tamanho}×${tamanho}  ${(png.length / 1024).toFixed(1)} kB`);
}

console.log(`\n  Ícones gerados em public/icones/\n`);
