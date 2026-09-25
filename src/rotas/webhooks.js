/**
 * Webhooks — o gatilho automático.
 *
 * Duas partes aqui:
 *  1. /api/webhooks/*  → painel do admin (criar, editar, rotacionar chave)
 *  2. /hook/:slug      → endereço público que as ferramentas externas chamam
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { db } from '../db/index.js';
import { config, LIMITE_TITULO, LIMITE_TEXTO } from '../config.js';
import { tipoExiste } from '../servicos/tipos.js';
import { exigirNivel } from '../middlewares/auth.js';
import { publicarNotificacao } from '../servicos/push.js';
import { aplicarModelo, variaveisDisponiveis, primeiroCampo } from '../servicos/modelo.js';
import { resolverSetor } from '../servicos/setores.js';

export const rotasWebhooks = Router();
export const rotasGatilho = Router();

// Nomes aceitos para cada campo no modo direto. Quanto mais tolerante,
// menos tempo perdido acertando o nome exato na ferramenta que dispara.
const ALIAS_TITULO = ['titulo', 'title', 'assunto', 'subject'];
const ALIAS_TEXTO = ['texto', 'mensagem', 'message', 'body', 'descricao', 'text'];

const novoSlug = () => crypto.randomBytes(9).toString('base64url'); // 12 caracteres
const novaChave = () => crypto.randomBytes(24).toString('base64url'); // 32 caracteres

/** Monta o endereço completo que o admin copia e cola na ferramenta externa. */
const enderecoDo = (slug) => `${config.appUrl}/hook/${slug}`;

function comEndereco(webhook) {
  return { ...webhook, endereco: enderecoDo(webhook.slug) };
}

// ─────────────────────────────────────────────────────────────
// Painel do administrador
// ─────────────────────────────────────────────────────────────

rotasWebhooks.use(exigirNivel('admin'));

rotasWebhooks.get('/', (_req, res) => {
  const itens = db.prepare('SELECT * FROM webhooks ORDER BY id DESC').all().map(comEndereco);
  res.json({ itens });
});

rotasWebhooks.post('/', (req, res) => {
  const nome = String(req.body?.nome || '').trim();
  const modo = req.body?.modo === 'modelo' ? 'modelo' : 'direto';
  const modeloTitulo = String(req.body?.modelo_titulo || '').trim();
  const modeloTexto = String(req.body?.modelo_texto || '').trim();
  const tipo = tipoExiste(req.body?.tipo) ? req.body.tipo : 'lead';
  const publico = String(req.body?.publico || 'todos').trim();

  if (!nome) return res.status(400).json({ erro: 'Dê um nome ao webhook.' });
  // No modo direto os modelos são opcionais: servem só de reserva para
  // quando a chamada não trouxer um dos dois campos.
  if (modo === 'modelo' && (!modeloTitulo || !modeloTexto)) {
    return res.status(400).json({ erro: 'Preencha o modelo de título e de mensagem.' });
  }

  const info = db
    .prepare(
      `INSERT INTO webhooks (nome, slug, chave_secreta, modo, modelo_titulo, modelo_texto, tipo, publico, criado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nome,
      novoSlug(),
      novaChave(),
      modo,
      modeloTitulo,
      modeloTexto,
      tipo,
      publico,
      req.usuario.id
    );

  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ webhook: comEndereco(webhook) });
});

rotasWebhooks.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const atual = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
  if (!atual) return res.status(404).json({ erro: 'Webhook não encontrado.' });

  const campos = {
    nome: req.body?.nome !== undefined ? String(req.body.nome).trim() : atual.nome,
    modo: ['direto', 'modelo'].includes(req.body?.modo) ? req.body.modo : atual.modo,
    modelo_titulo:
      req.body?.modelo_titulo !== undefined
        ? String(req.body.modelo_titulo).trim()
        : atual.modelo_titulo,
    modelo_texto:
      req.body?.modelo_texto !== undefined
        ? String(req.body.modelo_texto).trim()
        : atual.modelo_texto,
    tipo: tipoExiste(req.body?.tipo) ? req.body.tipo : atual.tipo,
    publico: req.body?.publico !== undefined ? String(req.body.publico).trim() : atual.publico,
    ativo: req.body?.ativo !== undefined ? (req.body.ativo ? 1 : 0) : atual.ativo,
  };

  db.prepare(
    `UPDATE webhooks SET nome = ?, modo = ?, modelo_titulo = ?, modelo_texto = ?,
                         tipo = ?, publico = ?, ativo = ?
      WHERE id = ?`
  ).run(
    campos.nome,
    campos.modo,
    campos.modelo_titulo,
    campos.modelo_texto,
    campos.tipo,
    campos.publico,
    campos.ativo,
    id
  );

  res.json({ webhook: comEndereco(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id)) });
});

/** Gera uma chave secreta nova — invalida a antiga imediatamente. */
rotasWebhooks.post('/:id/rotacionar-chave', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('UPDATE webhooks SET chave_secreta = ? WHERE id = ?').run(novaChave(), id);
  if (!info.changes) return res.status(404).json({ erro: 'Webhook não encontrado.' });
  res.json({ webhook: comEndereco(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id)) });
});

/**
 * Reprocessa o histórico inteiro de uma vez.
 *
 * Passa por todas as notificações que vieram de webhook e grava nelas o
 * público que aquele webhook tem hoje. É o que organiza de um golpe o
 * histórico nascido antes de os setores existirem — sem isso, quem entra
 * no time hoje abre o aplicativo e encontra meses de avisos de setores
 * que não são dele.
 *
 * O que NÃO é tocado, e por quê:
 *
 *   • envios manuais — ali o público foi decisão de quem enviou, não
 *     configuração de um gatilho;
 *   • avisos de webhooks já excluídos — não há de onde tirar o setor.
 *
 * Os dois casos vão na resposta, para a interface dizer quantos avisos
 * continuam visíveis para todo mundo depois do reprocessamento.
 *
 * Sem ?confirmar=sim devolve 409 com o resumo. Não há desfazer.
 */
rotasWebhooks.post('/reprocessar-historico', (req, res) => {
  const porWebhook = db
    .prepare(
      `SELECT w.id, w.nome, w.publico, COUNT(*) AS quantidade
         FROM notificacoes n
         JOIN webhooks w ON w.id = n.webhook_id
        WHERE n.publico != w.publico
        GROUP BY w.id
        ORDER BY quantidade DESC`
    )
    .all();

  // Ficam de fora do reprocessamento e seguem visíveis para todo mundo.
  const manuais = db
    .prepare(`SELECT COUNT(*) AS n FROM notificacoes WHERE webhook_id IS NULL AND publico = 'todos'`)
    .get().n;
  const orfas = db
    .prepare(
      `SELECT COUNT(*) AS n FROM notificacoes n
        WHERE n.webhook_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM webhooks w WHERE w.id = n.webhook_id)`
    )
    .get().n;

  const total = porWebhook.reduce((soma, w) => soma + w.quantidade, 0);

  if (!total) {
    return res.json({ ok: true, alteradas: 0, semMudanca: true, manuais, orfas });
  }

  if (req.query.confirmar !== 'sim') {
    return res.status(409).json({
      erro: `${total} aviso(s) do histórico vão passar para o público atual do webhook que os gerou.`,
      total,
      porWebhook,
      manuais,
      orfas,
    });
  }

  const aplicar = db.transaction(() => {
    const atualizar = db.prepare(
      'UPDATE notificacoes SET publico = ? WHERE webhook_id = ? AND publico != ?'
    );
    let alteradas = 0;
    for (const w of porWebhook) alteradas += atualizar.run(w.publico, w.id, w.publico).changes;
    return alteradas;
  });

  res.json({ ok: true, alteradas: aplicar(), manuais, orfas });
});

/**
 * Aplica o público atual do webhook ao histórico que ele já gerou.
 *
 * O público fica gravado em cada notificação no momento do disparo, e é
 * ele que decide quem enxerga aquela linha depois. Por isso um webhook
 * reapontado para um setor não reorganiza o passado sozinho: os avisos
 * antigos continuam com o público que tinham.
 *
 * Esta rota reescreve esse campo nas notificações daquele webhook —
 * serve para segmentar de uma vez o histórico que nasceu antes dos
 * setores existirem.
 *
 * Envios manuais não são tocados: ali o público foi uma escolha
 * explícita de quem enviou, e não a configuração de um gatilho.
 *
 * Sem ?confirmar=sim a resposta é 409 com a contagem, para a interface
 * mostrar quantas linhas mudam antes de alguém decidir. Não há desfazer.
 */
rotasWebhooks.post('/:id/aplicar-publico', (req, res) => {
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(req.params.id));
  if (!webhook) return res.status(404).json({ erro: 'Webhook não encontrado.' });

  const afetadas = db
    .prepare('SELECT COUNT(*) AS n FROM notificacoes WHERE webhook_id = ? AND publico != ?')
    .get(webhook.id, webhook.publico).n;

  if (!afetadas) {
    return res.json({ ok: true, alteradas: 0, semMudanca: true });
  }

  if (req.query.confirmar !== 'sim') {
    return res.status(409).json({
      erro:
        `${afetadas} aviso(s) deste webhook estão no histórico com outro público. ` +
        `Aplicar o público atual muda quem enxerga essas linhas daqui em diante.`,
      afetadas,
    });
  }

  const info = db
    .prepare('UPDATE notificacoes SET publico = ? WHERE webhook_id = ?')
    .run(webhook.publico, webhook.id);

  res.json({ ok: true, alteradas: info.changes });
});

rotasWebhooks.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM webhooks WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ erro: 'Webhook não encontrado.' });
  res.json({ ok: true });
});

/**
 * Pré-visualização: aplica o modelo sobre um payload de exemplo sem
 * enviar nada. Deixa o admin conferir as variáveis antes de publicar.
 */
rotasWebhooks.post('/previa', (req, res) => {
  const dados = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
  res.json({
    titulo: aplicarModelo(req.body?.modelo_titulo || '', dados),
    texto: aplicarModelo(req.body?.modelo_texto || '', dados),
    variaveis: variaveisDisponiveis(dados),
  });
});

// ─────────────────────────────────────────────────────────────
// Endereço público do gatilho
// ─────────────────────────────────────────────────────────────

// Teto de segurança: 120 chamadas por minuto por IP no endereço público.
const limiteGatilho = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas chamadas. Reduza a frequência.' },
});

/** Comparação em tempo constante — não vaza a chave pelo tempo de resposta. */
function chaveConfere(recebida, esperada) {
  if (!recebida) return false;
  const a = Buffer.from(String(recebida));
  const b = Buffer.from(String(esperada));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * A chave pode vir de três jeitos, para acomodar qualquer ferramenta:
 *   - cabeçalho  X-Chave-Secreta: <chave>
 *   - cabeçalho  Authorization: Bearer <chave>
 *   - query      ?chave=<chave>       (último recurso; aparece em log de proxy)
 */
function extrairChave(req) {
  const cabecalho = req.get('x-chave-secreta');
  if (cabecalho) return cabecalho.trim();

  const auth = req.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();

  if (req.query.chave) return String(req.query.chave).trim();
  return null;
}

/**
 * POST (ou GET) /hook/:slug
 *
 * Aceita qualquer JSON no corpo. Em GET, os parâmetros da query viram
 * os dados — assim uma planilha ou um script simples também consegue disparar.
 */
async function dispararGatilho(req, res) {
  const webhook = db.prepare('SELECT * FROM webhooks WHERE slug = ?').get(req.params.slug);

  // Mesma resposta para slug inexistente e chave errada: não confirma
  // para quem está sondando que aquele endereço existe.
  if (!webhook || !chaveConfere(extrairChave(req), webhook.chave_secreta)) {
    return res.status(401).json({ erro: 'Gatilho ou chave inválidos.' });
  }
  if (!webhook.ativo) {
    return res.status(409).json({ erro: 'Este gatilho está desativado.' });
  }

  const dados =
    req.method === 'GET'
      ? { ...req.query }
      : req.body && typeof req.body === 'object'
        ? req.body
        : {};
  delete dados.chave; // não deixa a chave secreta vazar para o histórico

  let titulo;
  let texto;

  if (webhook.modo === 'direto') {
    // O título e o texto vêm prontos. É o caminho para o n8n, o Make e
    // qualquer ferramenta que já monta a mensagem antes de chamar.
    titulo = primeiroCampo(dados, ALIAS_TITULO);
    texto = primeiroCampo(dados, ALIAS_TEXTO);

    if (!titulo && !texto) {
      return res.status(400).json({
        erro: 'Envie "titulo" e "texto" no corpo da requisição.',
        exemplo: {
          titulo: 'Venda aprovada',
          texto: 'A compra de Maria Souza foi confirmada.',
          tipo: 'meta',
        },
        aceito_tambem: {
          titulo: ALIAS_TITULO,
          texto: ALIAS_TEXTO,
        },
      });
    }

    // Se só um dos dois vier, o modelo cadastrado cobre o que faltou.
    if (!titulo) titulo = aplicarModelo(webhook.modelo_titulo, dados).trim() || webhook.nome;
    if (!texto) texto = aplicarModelo(webhook.modelo_texto, dados).trim();
  } else {
    titulo = aplicarModelo(webhook.modelo_titulo, dados).trim() || webhook.nome;
    texto = aplicarModelo(webhook.modelo_texto, dados).trim();
  }

  if (!texto) texto = 'Evento recebido pelo webhook.';

  // O tipo pode vir no próprio evento — assim um mesmo gatilho serve para
  // avisos de naturezas diferentes, sem precisar criar vários webhooks.
  const tipo = tipoExiste(dados.tipo) ? dados.tipo : webhook.tipo;

  /*
   * O evento também pode mirar um setor, por id ou por nome:
   *   { "setor": "Comercial" }
   *
   * Valor ausente ou desconhecido é ignorado, e vale o público cadastrado
   * no webhook. Isso é proposital: nenhuma chamada que já funciona pode
   * passar a falhar — nem a mudar de destinatário — por causa deste campo.
   */
  const setorDoEvento = resolverSetor(dados.setor ?? dados.setor_id);
  const publico = setorDoEvento ? `setor:${setorDoEvento.id}` : webhook.publico;

  const resultado = await publicarNotificacao({
    titulo: titulo.slice(0, LIMITE_TITULO),
    texto: texto.slice(0, LIMITE_TEXTO),
    tipo,
    origem: 'webhook',
    publico,
    webhookId: webhook.id,
    payload: dados,
  });

  db.prepare(
    `UPDATE webhooks SET ultimo_disparo_em = datetime('now'), total_disparos = total_disparos + 1
      WHERE id = ?`
  ).run(webhook.id);

  res.status(202).json({
    ok: true,
    notificacao_id: resultado.notificacao.id,
    entregues: resultado.entregues,
    falhas: resultado.falhas,
  });
}

rotasGatilho.post('/:slug', limiteGatilho, dispararGatilho);
rotasGatilho.get('/:slug', limiteGatilho, dispararGatilho);
