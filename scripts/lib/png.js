/**
 * Leitor e escritor de PNG em Node puro — sem nenhuma dependência.
 *
 * Cobre o necessário para tratar a logo da marca: 8 bits por canal, RGB ou
 * RGBA, sem entrelaçamento. É o suficiente para gerar todos os ícones do
 * PWA a partir do arquivo original, e mantém o processo reprodutível em
 * qualquer máquina (inclusive no build do GitHub).
 */
import zlib from 'node:zlib';

// ── CRC32, exigido em todo bloco do formato ─────────────────────

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

// ── Leitura ─────────────────────────────────────────────────────

/** Desfaz o filtro de uma linha. O PNG escolhe um dos 5 por linha. */
function desfiltrar(tipo, linha, anterior, bpp) {
  const n = linha.length;
  switch (tipo) {
    case 0: // nenhum
      break;
    case 1: // Sub — soma o pixel da esquerda
      for (let i = bpp; i < n; i++) linha[i] = (linha[i] + linha[i - bpp]) & 0xff;
      break;
    case 2: // Up — soma o pixel de cima
      for (let i = 0; i < n; i++) linha[i] = (linha[i] + anterior[i]) & 0xff;
      break;
    case 3: // Average — média entre esquerda e cima
      for (let i = 0; i < n; i++) {
        const esq = i >= bpp ? linha[i - bpp] : 0;
        linha[i] = (linha[i] + ((esq + anterior[i]) >> 1)) & 0xff;
      }
      break;
    case 4: // Paeth — escolhe o vizinho mais provável
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? linha[i - bpp] : 0;
        const b = anterior[i];
        const c = i >= bpp ? anterior[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        linha[i] = (linha[i] + pred) & 0xff;
      }
      break;
    default:
      throw new Error(`Filtro PNG desconhecido: ${tipo}`);
  }
  return linha;
}

/**
 * Decodifica um PNG.
 * @returns {{largura: number, altura: number, rgba: Buffer}}
 */
export function lerPNG(buffer) {
  const assinatura = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== assinatura[i]) throw new Error('Arquivo não é um PNG.');
  }

  let pos = 8;
  let largura = 0;
  let altura = 0;
  let profundidade = 0;
  let tipoCor = 0;
  const partesIDAT = [];

  while (pos < buffer.length) {
    const tamanho = buffer.readUInt32BE(pos);
    const tipo = buffer.toString('ascii', pos + 4, pos + 8);
    const dados = buffer.subarray(pos + 8, pos + 8 + tamanho);

    if (tipo === 'IHDR') {
      largura = dados.readUInt32BE(0);
      altura = dados.readUInt32BE(4);
      profundidade = dados[8];
      tipoCor = dados[9];
      if (dados[12] !== 0) throw new Error('PNG entrelaçado não é suportado.');
    } else if (tipo === 'IDAT') {
      partesIDAT.push(dados);
    } else if (tipo === 'IEND') {
      break;
    }

    pos += 12 + tamanho; // tamanho + tipo(4) + dados + crc(4)
  }

  if (profundidade !== 8) throw new Error(`Só suporto 8 bits por canal (veio ${profundidade}).`);
  if (tipoCor !== 2 && tipoCor !== 6) {
    throw new Error(`Só suporto RGB ou RGBA (tipo de cor ${tipoCor}).`);
  }

  const canais = tipoCor === 6 ? 4 : 3;
  const bruto = zlib.inflateSync(Buffer.concat(partesIDAT));
  const rgba = Buffer.alloc(largura * altura * 4);

  let anterior = Buffer.alloc(largura * canais);
  let leitura = 0;

  for (let y = 0; y < altura; y++) {
    const filtro = bruto[leitura++];
    const linha = Buffer.from(bruto.subarray(leitura, leitura + largura * canais));
    leitura += largura * canais;

    desfiltrar(filtro, linha, anterior, canais);

    for (let x = 0; x < largura; x++) {
      const origem = x * canais;
      const destino = (y * largura + x) * 4;
      rgba[destino] = linha[origem];
      rgba[destino + 1] = linha[origem + 1];
      rgba[destino + 2] = linha[origem + 2];
      rgba[destino + 3] = canais === 4 ? linha[origem + 3] : 255;
    }

    anterior = linha;
  }

  return { largura, altura, rgba };
}

// ── Escrita ─────────────────────────────────────────────────────

function bloco(tipo, dados) {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, crc]);
}

/** Codifica RGBA em PNG. */
export function escreverPNG(largura, altura, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // profundidade
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
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    bloco('IHDR', ihdr),
    bloco('IDAT', zlib.deflateSync(linhas, { level: 9 })),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

// ── Operações de imagem ─────────────────────────────────────────

/** Luminância percebida (0–255). */
export const luz = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Recorta a imagem, redimensionando por média de área.
 *
 * Média de área (e não vizinho mais próximo) importa aqui: a logo tem
 * traços finos que sumiriam ou virariam serrilhado ao encolher para 32px.
 */
export function redimensionar(origem, alvoLargura, alvoAltura, recorte = null) {
  const { largura: lo, altura: ao, rgba: fonte } = origem;
  const r = recorte || { x: 0, y: 0, largura: lo, altura: ao };
  const saida = Buffer.alloc(alvoLargura * alvoAltura * 4);

  const escalaX = r.largura / alvoLargura;
  const escalaY = r.altura / alvoAltura;

  for (let y = 0; y < alvoAltura; y++) {
    const y0 = r.y + y * escalaY;
    const y1 = Math.min(r.y + (y + 1) * escalaY, r.y + r.altura);

    for (let x = 0; x < alvoLargura; x++) {
      const x0 = r.x + x * escalaX;
      const x1 = Math.min(r.x + (x + 1) * escalaX, r.x + r.largura);

      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let n = 0;

      for (let py = Math.floor(y0); py < Math.max(Math.ceil(y1), Math.floor(y0) + 1); py++) {
        if (py < 0 || py >= ao) continue;
        for (let px = Math.floor(x0); px < Math.max(Math.ceil(x1), Math.floor(x0) + 1); px++) {
          if (px < 0 || px >= lo) continue;
          const i = (py * lo + px) * 4;
          const a = fonte[i + 3] / 255;
          // Soma na forma pré-multiplicada, senão pixels transparentes
          // "puxam" a cor da média e criam halo nas bordas.
          sr += fonte[i] * a;
          sg += fonte[i + 1] * a;
          sb += fonte[i + 2] * a;
          sa += a;
          n++;
        }
      }

      const destino = (y * alvoLargura + x) * 4;
      if (n === 0 || sa === 0) {
        saida[destino + 3] = 0;
        continue;
      }
      saida[destino] = Math.round(sr / sa);
      saida[destino + 1] = Math.round(sg / sa);
      saida[destino + 2] = Math.round(sb / sa);
      saida[destino + 3] = Math.round((sa / n) * 255);
    }
  }

  return { largura: alvoLargura, altura: alvoAltura, rgba: saida };
}

/** Desenha uma imagem sobre outra, respeitando a transparência. */
export function compor(base, camada, offsetX, offsetY) {
  for (let y = 0; y < camada.altura; y++) {
    const by = y + offsetY;
    if (by < 0 || by >= base.altura) continue;

    for (let x = 0; x < camada.largura; x++) {
      const bx = x + offsetX;
      if (bx < 0 || bx >= base.largura) continue;

      const i = (y * camada.largura + x) * 4;
      const j = (by * base.largura + bx) * 4;
      const a = camada.rgba[i + 3] / 255;
      if (a === 0) continue;

      for (let c = 0; c < 3; c++) {
        base.rgba[j + c] = Math.round(camada.rgba[i + c] * a + base.rgba[j + c] * (1 - a));
      }
      base.rgba[j + 3] = Math.max(base.rgba[j + 3], camada.rgba[i + 3]);
    }
  }
  return base;
}

/** Cria uma tela de cor sólida (ou transparente). */
export function tela(largura, altura, cor = null) {
  const rgba = Buffer.alloc(largura * altura * 4);
  if (cor) {
    for (let i = 0; i < largura * altura; i++) {
      rgba[i * 4] = cor[0];
      rgba[i * 4 + 1] = cor[1];
      rgba[i * 4 + 2] = cor[2];
      rgba[i * 4 + 3] = 255;
    }
  }
  return { largura, altura, rgba };
}
