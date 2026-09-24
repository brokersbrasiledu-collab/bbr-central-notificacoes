/**
 * Categorias de notificação.
 *
 * Antes eram uma lista fixa no código. Agora vivem no banco, porque o
 * administrador cria as suas — e cada categoria nova precisa aparecer
 * sozinha na tela de preferências, para o time escolher se quer receber.
 *
 * As consultas aqui são diretas, sem cache: a tabela tem poucas linhas e
 * o SQLite é local. Um cache traria o risco clássico de o admin criar uma
 * categoria e ela não valer na hora de enviar.
 */
import { db } from '../db/index.js';

/** Cores disponíveis. Fechado de propósito: mantém a interface coerente. */
export const CORES = ['ouro', 'vermelho', 'verde', 'azul', 'neutro'];

/** Todas as categorias, na ordem de exibição. */
export function listarTipos() {
  return db
    .prepare(
      `SELECT chave, rotulo, descricao, cor, fixo, silenciavel, ordem
         FROM tipos ORDER BY ordem, rotulo COLLATE NOCASE`
    )
    .all();
}

export function buscarTipo(chave) {
  return db.prepare('SELECT * FROM tipos WHERE chave = ?').get(String(chave || ''));
}

/** Existe? É o que substitui o antigo TIPOS.includes(...). */
export function tipoExiste(chave) {
  return Boolean(buscarTipo(chave));
}

/** Categorias que a pessoa pode silenciar. */
export function tiposSilenciaveis() {
  return db
    .prepare('SELECT chave FROM tipos WHERE silenciavel = 1 ORDER BY ordem, rotulo COLLATE NOCASE')
    .all()
    .map((t) => t.chave);
}

/**
 * Transforma um nome livre numa chave curta e previsível:
 * "Contrato Assinado!" → "contrato-assinado".
 *
 * A chave é o que fica gravado em cada notificação e o que as integrações
 * mandam no JSON, então precisa ser estável e sem acento.
 */
export function gerarChave(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // tira os acentos separados pelo NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
