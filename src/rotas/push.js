/**
 * Rotas de push: chave pública, inscrição do aparelho e envio de teste.
 * É a base da Etapa 1 (fazer o primeiro celular receber notificação).
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { exigirLogin } from '../middlewares/auth.js';
import { enviarParaAparelhos, vapidPronto } from '../servicos/push.js';

export const rotasPush = Router();

/**
 * Tipos que a pessoa pode silenciar.
 *
 * "sistema" fica de fora: é o canal dos testes e dos avisos do próprio
 * app. Se desse para silenciar, o botão "enviar teste" pareceria quebrado.
 */
const TIPOS_ESCOLHIVEIS = ['lead', 'alerta', 'meta', 'aviso'];

/**
 * O navegador precisa da chave pública VAPID para criar a subscription.
 * É pública por definição — pode ser servida sem login.
 */
rotasPush.get('/chave-publica', (_req, res) => {
  if (!config.vapid.publica) {
    return res.status(503).json({ erro: 'Servidor sem chaves VAPID configuradas.' });
  }
  res.json({ chave: config.vapid.publica });
});

/**
 * Registra (ou atualiza) o aparelho do usuário logado.
 *
 * O mesmo endpoint pode reaparecer depois de o navegador renovar a
 * subscription — por isso o UPSERT em cima de `endpoint`, que é único.
 */
rotasPush.post('/inscrever', exigirLogin, (req, res) => {
  const inscricao = req.body?.subscription;
  const endpoint = inscricao?.endpoint;
  const p256dh = inscricao?.keys?.p256dh;
  const auth = inscricao?.keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ erro: 'Inscrição de push inválida ou incompleta.' });
  }

  db.prepare(
    `INSERT INTO aparelhos (usuario_id, endpoint, p256dh, auth, plataforma, user_agent, ultimo_uso_em)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(endpoint) DO UPDATE SET
       usuario_id    = excluded.usuario_id,
       p256dh        = excluded.p256dh,
       auth          = excluded.auth,
       plataforma    = excluded.plataforma,
       user_agent    = excluded.user_agent,
       ultimo_uso_em = datetime('now')`
  ).run(
    req.usuario.id,
    endpoint,
    p256dh,
    auth,
    String(req.body?.plataforma || '').slice(0, 40) || null,
    String(req.get('user-agent') || '').slice(0, 300) || null
  );

  res.json({ ok: true });
});

/** Remove a inscrição (usuário desligou as notificações neste aparelho). */
rotasPush.post('/desinscrever', exigirLogin, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ erro: 'Endpoint não informado.' });

  db.prepare('DELETE FROM aparelhos WHERE endpoint = ? AND usuario_id = ?').run(
    endpoint,
    req.usuario.id
  );
  res.json({ ok: true });
});

/**
 * Preferências de notificação do próprio usuário.
 *
 * A resposta lista os tipos LIGADOS, que é como a interface pensa. No
 * banco guardamos o contrário (os silenciados), para que "recebe tudo"
 * seja o estado natural de quem nunca mexeu nisso.
 */
rotasPush.get('/preferencias', exigirLogin, (req, res) => {
  const silenciados = db
    .prepare('SELECT tipo FROM preferencias_tipo WHERE usuario_id = ?')
    .all(req.usuario.id)
    .map((linha) => linha.tipo);

  res.json({
    tipos: TIPOS_ESCOLHIVEIS.map((tipo) => ({
      tipo,
      ativo: !silenciados.includes(tipo),
    })),
  });
});

/** Liga ou desliga um tipo para o usuário logado. */
rotasPush.post('/preferencias', exigirLogin, (req, res) => {
  const tipo = req.body?.tipo;
  const ativo = req.body?.ativo !== false;

  if (!TIPOS_ESCOLHIVEIS.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de notificação inválido.' });
  }

  if (ativo) {
    db.prepare('DELETE FROM preferencias_tipo WHERE usuario_id = ? AND tipo = ?').run(
      req.usuario.id,
      tipo
    );
  } else {
    db.prepare(
      'INSERT OR IGNORE INTO preferencias_tipo (usuario_id, tipo) VALUES (?, ?)'
    ).run(req.usuario.id, tipo);
  }

  res.json({ ok: true, tipo, ativo });
});

/** Aparelhos do próprio usuário — mostrado na tela de ativação. */
rotasPush.get('/meus-aparelhos', exigirLogin, (req, res) => {
  const aparelhos = db
    .prepare(
      `SELECT id, plataforma, criado_em, ultimo_uso_em
         FROM aparelhos WHERE usuario_id = ? ORDER BY id DESC`
    )
    .all(req.usuario.id);
  res.json({ aparelhos });
});

/**
 * Envia uma notificação de teste só para os aparelhos de quem chamou.
 * Não entra no histórico — é diagnóstico, não comunicado.
 */
rotasPush.post('/teste', exigirLogin, async (req, res) => {
  if (!vapidPronto()) {
    return res.status(503).json({ erro: 'Servidor sem chaves VAPID configuradas.' });
  }

  const aparelhos = db
    .prepare('SELECT id, endpoint, p256dh, auth FROM aparelhos WHERE usuario_id = ?')
    .all(req.usuario.id);

  if (!aparelhos.length) {
    return res
      .status(400)
      .json({ erro: 'Nenhum aparelho inscrito. Ative as notificações primeiro.' });
  }

  const resultado = await enviarParaAparelhos(aparelhos, {
    id: 0,
    titulo: 'Notificação de teste',
    texto: `Tudo certo, ${req.usuario.nome.split(' ')[0]}. Este aparelho está recebendo push.`,
    tipo: 'sistema',
    origem: 'sistema',
    url: `${config.appUrl}/#/historico`,
    criada_em: new Date().toISOString(),
  });

  res.json({ ok: true, ...resultado });
});
