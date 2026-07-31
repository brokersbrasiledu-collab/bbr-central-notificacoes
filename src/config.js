/**
 * Configuração central — lê o .env uma única vez e expõe valores já
 * normalizados para o resto da aplicação.
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));

/** Raiz do projeto (um nível acima de /src). */
export const RAIZ = path.resolve(aqui, '..');

const bool = (v, padrao = false) =>
  v === undefined ? padrao : ['1', 'true', 'sim', 'yes'].includes(String(v).toLowerCase());

export const config = {
  porta: Number(process.env.PORT || 3000),
  ambiente: process.env.NODE_ENV || 'development',

  // Commit que gerou a imagem, injetado no build. Fica curto para caber
  // na conferência rápida em /api/saude.
  versao: (process.env.VERSAO || 'local').slice(0, 7),
  producao: process.env.NODE_ENV === 'production',
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  confiarProxy: bool(process.env.TRUST_PROXY),

  // Banco: caminho relativo é resolvido a partir da raiz do projeto.
  dbPath: path.isAbsolute(process.env.DB_PATH || '')
    ? process.env.DB_PATH
    : path.join(RAIZ, process.env.DB_PATH || './dados/central.db'),

  jwtSegredo: process.env.JWT_SECRET || '',
  sessaoDuracao: process.env.SESSAO_DURACAO || '30d',
  cookieNome: 'bbr_sessao',

  vapid: {
    publica: process.env.VAPID_PUBLIC_KEY || '',
    privada: process.env.VAPID_PRIVATE_KEY || '',
    assunto: process.env.VAPID_SUBJECT || 'mailto:contato@brokersbrasil.com.br',
  },

  admin: {
    nome: process.env.ADMIN_NOME || 'Administrador',
    email: (process.env.ADMIN_EMAIL || 'admin@brokersbrasil.com.br').toLowerCase().trim(),
    senha: process.env.ADMIN_SENHA || '',
  },
};

/** Níveis de acesso, do mais alto para o mais baixo. */
export const NIVEIS = ['admin', 'operador', 'membro'];

/** Peso de cada nível — usado para checar "tem pelo menos o nível X". */
export const PESO_NIVEL = { admin: 3, operador: 2, membro: 1 };

/** Tipos de notificação aceitos (usados para cor e rótulo na interface). */
export const TIPOS = ['lead', 'alerta', 'meta', 'aviso', 'sistema'];

/**
 * Limites de tamanho.
 *
 * O título é o que aparece na tela do celular, então é curto de propósito.
 * O texto é generoso: o sistema operacional corta o que não couber na
 * notificação, mas o histórico guarda e mostra tudo — que é justamente
 * para onde a pessoa vai quando o aviso é grande demais para a prévia.
 */
export const LIMITE_TITULO = 120;
export const LIMITE_TEXTO = 2000;

/**
 * Valida a configuração mínima na subida do servidor.
 * Devolve a lista de problemas encontrados (vazia = tudo certo).
 */
export function validarConfig() {
  const problemas = [];
  if (!config.jwtSegredo || config.jwtSegredo.length < 24) {
    problemas.push('JWT_SECRET ausente ou curto demais (use pelo menos 24 caracteres).');
  }
  if (config.producao && config.jwtSegredo.startsWith('troque-este-valor')) {
    problemas.push('JWT_SECRET ainda está com o valor de exemplo.');
  }
  if (!config.vapid.publica || !config.vapid.privada) {
    problemas.push('Chaves VAPID ausentes. Rode "npm run vapid" e cole no .env.');
  }
  return problemas;
}
