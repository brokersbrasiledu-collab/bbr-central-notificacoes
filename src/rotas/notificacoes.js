/**
 * Rotas do histórico (linha do tempo) e do envio manual de push.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { LIMITE_TITULO, LIMITE_TEXTO } from '../config.js';
import { tipoExiste } from '../servicos/tipos.js';
import { exigirLogin, exigirNivel } from '../middlewares/auth.js';
import { publicarNotificacao, aparelhosDoPublico } from '../servicos/push.js';
import { inicioDoDiaUTC } from '../servicos/datas.js';

export const rotasNotificacoes = Router();

/**
 * Linha do tempo — da mais recente para a mais antiga.
 *
 * Paginação por cursor (`antes=<id>`): mais estável que offset quando
 * chegam notificações novas enquanto o usuário rola a lista.
 */
const PERIODOS = { hoje: 0, '7d': 6, '30d': 29 };

rotasNotificacoes.get('/', exigirLogin, (req, res) => {
  const limite = Math.min(Math.max(Number(req.query.limite) || 30, 1), 100);
  const antes = Number(req.query.antes) || null;
  const tipo = tipoExiste(req.query.tipo) ? req.query.tipo : null;
  const busca = String(req.query.busca || '').trim().slice(0, 80);
  const periodo = Object.hasOwn(PERIODOS, req.query.periodo) ? req.query.periodo : null;

  const condicoes = [];
  const valores = [];

  if (antes) {
    condicoes.push('n.id < ?');
    valores.push(antes);
  }
  if (tipo) {
    condicoes.push('n.tipo = ?');
    valores.push(tipo);
  }
  if (busca) {
    // Procura no título e no corpo: quem lembra de um trecho da mensagem
    // acha do mesmo jeito. O escape evita que % e _ digitados virem curinga.
    const termo = `%${busca.replace(/[%_\\]/g, '\\$&')}%`;
    condicoes.push(`(n.titulo LIKE ? ESCAPE '\\' OR n.texto LIKE ? ESCAPE '\\')`);
    valores.push(termo, termo);
  }
  if (periodo) {
    condicoes.push('n.criada_em >= ?');
    valores.push(inicioDoDiaUTC(PERIODOS[periodo]));
  }

  const onde = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const itens = db
    .prepare(
      `SELECT n.id, n.titulo, n.texto, n.tipo, n.origem, n.publico,
              n.entregues, n.falhas, n.criada_em,
              u.nome AS autor, w.nome AS webhook
         FROM notificacoes n
         LEFT JOIN usuarios u ON u.id = n.criada_por
         LEFT JOIN webhooks w ON w.id = n.webhook_id
         ${onde}
        ORDER BY n.id DESC
        LIMIT ?`
    )
    .all(...valores, limite + 1);

  const temMais = itens.length > limite;
  res.json({ itens: itens.slice(0, limite), temMais });
});

/** Contagem rápida por tipo — alimenta o resumo no topo do histórico. */
rotasNotificacoes.get('/resumo', exigirLogin, (_req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM notificacoes').get().n;
  const hoje = db
    .prepare(`SELECT COUNT(*) AS n FROM notificacoes WHERE date(criada_em) = date('now')`)
    .get().n;
  const porTipo = db
    .prepare('SELECT tipo, COUNT(*) AS n FROM notificacoes GROUP BY tipo')
    .all();
  res.json({ total, hoje, porTipo });
});

/**
 * Envio manual — admin e operador.
 * Grava no histórico e dispara o push de uma vez só.
 */
rotasNotificacoes.post('/enviar', exigirNivel('operador'), async (req, res) => {
  const titulo = String(req.body?.titulo || '').trim();
  const texto = String(req.body?.texto || '').trim();
  const tipo = tipoExiste(req.body?.tipo) ? req.body.tipo : 'aviso';
  const publico = String(req.body?.publico || 'todos').trim();

  if (!titulo) return res.status(400).json({ erro: 'O título é obrigatório.' });
  if (titulo.length > LIMITE_TITULO)
    return res
      .status(400)
      .json({ erro: `O título deve ter no máximo ${LIMITE_TITULO} caracteres.` });
  if (!texto) return res.status(400).json({ erro: 'A mensagem é obrigatória.' });
  if (texto.length > LIMITE_TEXTO)
    return res
      .status(400)
      .json({ erro: `A mensagem deve ter no máximo ${LIMITE_TEXTO} caracteres.` });

  const resultado = await publicarNotificacao({
    titulo,
    texto,
    tipo,
    origem: 'manual',
    publico,
    criadaPor: req.usuario.id,
  });

  res.status(201).json({
    ok: true,
    notificacao: resultado.notificacao,
    entregues: resultado.entregues,
    falhas: resultado.falhas,
    aparelhosAlvo: resultado.aparelhosAlvo,
  });
});

/**
 * Quantos aparelhos seriam atingidos por um público alvo.
 * A tela de envio usa isso para mostrar "chega em N aparelhos".
 */
rotasNotificacoes.get('/alcance', exigirNivel('operador'), (req, res) => {
  const publico = String(req.query.publico || 'todos');
  // O tipo importa no cálculo: quem silenciou aquele tipo não entra na conta.
  const tipo = tipoExiste(req.query.tipo) ? req.query.tipo : null;
  res.json({ aparelhos: aparelhosDoPublico(publico, tipo).length });
});

/** Apagar uma linha do histórico — só admin. */
rotasNotificacoes.delete('/:id', exigirNivel('admin'), (req, res) => {
  const info = db.prepare('DELETE FROM notificacoes WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ erro: 'Notificação não encontrada.' });
  res.json({ ok: true });
});
