/**
 * Serviço de push — a ponte entre o backend e os servidores do Google
 * (FCM, para Android/Chrome) e da Apple (APNs, para iPhone/Safari).
 *
 * A biblioteca `web-push` cuida do protocolo Web Push: assina a
 * requisição com as chaves VAPID e criptografa o payload com as chaves
 * da subscription do aparelho. Não passa por Meta e não tem custo.
 */
import webpush from 'web-push';
import { db } from '../db/index.js';
import { config } from '../config.js';

let configurado = false;

/** Aplica as chaves VAPID na biblioteca. Chamado na subida do servidor. */
export function configurarVapid() {
  if (!config.vapid.publica || !config.vapid.privada) return false;
  webpush.setVapidDetails(config.vapid.assunto, config.vapid.publica, config.vapid.privada);
  configurado = true;
  return true;
}

export const vapidPronto = () => configurado;

/**
 * Traduz o "público alvo" numa lista de aparelhos.
 *
 * Formatos aceitos em `publico`:
 *   "todos"                  → todo mundo ativo
 *   "admin" / "operador"...  → um ou mais níveis, separados por vírgula
 *   "usuarios:3,7"           → usuários específicos por id
 */
export function aparelhosDoPublico(publico = 'todos') {
  const alvo = String(publico || 'todos').trim();

  const base = `
    SELECT a.id, a.endpoint, a.p256dh, a.auth, a.usuario_id
      FROM aparelhos a
      JOIN usuarios u ON u.id = a.usuario_id
     WHERE u.ativo = 1`;

  if (alvo === 'todos' || alvo === '') {
    return db.prepare(base).all();
  }

  if (alvo.startsWith('usuarios:')) {
    const ids = alvo
      .slice('usuarios:'.length)
      .split(',')
      .map((n) => Number(n.trim()))
      .filter(Number.isInteger);
    if (!ids.length) return [];
    const marcadores = ids.map(() => '?').join(',');
    return db.prepare(`${base} AND u.id IN (${marcadores})`).all(...ids);
  }

  const niveis = alvo
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => ['admin', 'operador', 'membro'].includes(n));
  if (!niveis.length) return [];
  const marcadores = niveis.map(() => '?').join(',');
  return db.prepare(`${base} AND u.nivel IN (${marcadores})`).all(...niveis);
}

/** Remove do banco um aparelho cuja inscrição o serviço de push recusou. */
function descartarAparelho(id) {
  db.prepare('DELETE FROM aparelhos WHERE id = ?').run(id);
}

/**
 * Envia o payload para uma lista de aparelhos.
 * Devolve { entregues, falhas, removidos }.
 *
 * Códigos 404 e 410 significam "essa inscrição morreu" (app desinstalado,
 * permissão revogada). Nesse caso limpamos o registro para não acumular lixo.
 */
export async function enviarParaAparelhos(aparelhos, payload) {
  if (!configurado) throw new Error('VAPID não configurado — rode "npm run vapid".');

  const corpo = JSON.stringify(payload);
  let entregues = 0;
  let falhas = 0;
  let removidos = 0;

  const resultados = await Promise.allSettled(
    aparelhos.map((ap) =>
      webpush.sendNotification(
        { endpoint: ap.endpoint, keys: { p256dh: ap.p256dh, auth: ap.auth } },
        corpo,
        { TTL: 60 * 60 * 24, urgency: 'high' }
      )
    )
  );

  resultados.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      entregues++;
      return;
    }
    falhas++;
    const status = r.reason?.statusCode;
    if (status === 404 || status === 410) {
      descartarAparelho(aparelhos[i].id);
      removidos++;
    } else {
      console.error(
        `[push] falha no aparelho ${aparelhos[i].id} (status ${status ?? '?'}):`,
        r.reason?.body || r.reason?.message || r.reason
      );
    }
  });

  return { entregues, falhas, removidos };
}

/**
 * Fluxo completo: grava no histórico e dispara o push.
 *
 * Grava primeiro para que a notificação exista na linha do tempo mesmo
 * que a entrega falhe — o histórico é a fonte de verdade.
 */
export async function publicarNotificacao({
  titulo,
  texto,
  tipo = 'aviso',
  origem = 'manual',
  publico = 'todos',
  webhookId = null,
  criadaPor = null,
  payload = null,
}) {
  const info = db
    .prepare(
      `INSERT INTO notificacoes
         (titulo, texto, tipo, origem, webhook_id, criada_por, publico, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      titulo,
      texto,
      tipo,
      origem,
      webhookId,
      criadaPor,
      publico,
      payload ? JSON.stringify(payload) : null
    );

  const id = info.lastInsertRowid;
  const aparelhos = aparelhosDoPublico(publico);

  let resultado = { entregues: 0, falhas: 0, removidos: 0 };
  if (aparelhos.length) {
    try {
      resultado = await enviarParaAparelhos(aparelhos, {
        id,
        titulo,
        texto,
        tipo,
        origem,
        url: `${config.appUrl}/#/historico`,
        criada_em: new Date().toISOString(),
      });
    } catch (erro) {
      console.error('[push] erro geral no envio:', erro.message);
    }
  }

  db.prepare('UPDATE notificacoes SET entregues = ?, falhas = ? WHERE id = ?').run(
    resultado.entregues,
    resultado.falhas,
    id
  );

  const notificacao = db.prepare('SELECT * FROM notificacoes WHERE id = ?').get(id);
  return { notificacao, ...resultado, aparelhosAlvo: aparelhos.length };
}
