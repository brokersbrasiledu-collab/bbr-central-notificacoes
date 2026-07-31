/**
 * Modelo de mensagem com variáveis dinâmicas.
 *
 * O admin escreve algo como:
 *   "Novo lead: {{nome}}"
 *   "{{nome}} pediu contato sobre {{imovel.titulo}} — {{telefone}}"
 *
 * e o webhook recebe um JSON qualquer. As chaves do JSON viram variáveis,
 * inclusive aninhadas (ponto) e itens de lista (colchete):
 *   {{lead.nome}}   {{itens[0].valor}}
 *
 * Variáveis embutidas, sempre disponíveis:
 *   {{agora}}      → 30/07/2026 21:07
 *   {{data}}       → 30/07/2026
 *   {{hora}}       → 21:07
 */

const FUSO = 'America/Sao_Paulo';

function agoraFormatado() {
  const d = new Date();
  const data = d.toLocaleDateString('pt-BR', { timeZone: FUSO });
  const hora = d.toLocaleTimeString('pt-BR', {
    timeZone: FUSO,
    hour: '2-digit',
    minute: '2-digit',
  });
  return { data, hora, agora: `${data} ${hora}` };
}

/** Caminha por um objeto seguindo "a.b[0].c". Devolve undefined se não achar. */
function buscarCaminho(objeto, caminho) {
  return caminho
    .replace(/\[(\d+)\]/g, '.$1') // itens[0] → itens.0
    .split('.')
    .filter(Boolean)
    .reduce((atual, parte) => (atual == null ? undefined : atual[parte]), objeto);
}

/** Converte qualquer valor num texto curto e legível para a notificação. */
function paraTexto(valor) {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  return JSON.stringify(valor);
}

/**
 * Aplica o modelo sobre os dados recebidos.
 * Variável não encontrada vira string vazia (não deixa "{{x}}" na tela).
 *
 * @param {string} modelo   texto com {{variaveis}}
 * @param {object} dados    corpo JSON recebido no webhook
 * @param {string} [padrao] valor usado quando a variável não existe
 */
export function aplicarModelo(modelo, dados = {}, padrao = '') {
  if (!modelo) return '';
  const embutidas = agoraFormatado();

  return String(modelo).replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_, chave) => {
    if (chave in embutidas) return embutidas[chave];
    const valor = buscarCaminho(dados, chave);
    return valor === undefined || valor === null || valor === ''
      ? padrao
      : paraTexto(valor);
  });
}

/** Lista as variáveis usadas num modelo — útil para pré-visualização. */
export function variaveisDoModelo(modelo) {
  const achadas = new Set();
  String(modelo || '').replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_, chave) => {
    achadas.add(chave);
    return '';
  });
  return [...achadas];
}

/**
 * Sugere as variáveis disponíveis a partir de um payload de exemplo.
 * Percorre o JSON até 3 níveis e devolve os caminhos "folha".
 */
export function variaveisDisponiveis(dados, prefixo = '', profundidade = 0) {
  if (profundidade > 3 || dados === null || typeof dados !== 'object') return [];
  const saida = [];
  for (const [chave, valor] of Object.entries(dados)) {
    const caminho = prefixo ? `${prefixo}.${chave}` : chave;
    if (valor !== null && typeof valor === 'object' && !Array.isArray(valor)) {
      saida.push(...variaveisDisponiveis(valor, caminho, profundidade + 1));
    } else {
      saida.push(caminho);
    }
  }
  return saida;
}
