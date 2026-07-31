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
import { config, TIPOS } from '../config.js';
import { exigirNivel } from '../middlewares/auth.js';
import { publicarNotificacao } from '../servicos/push.js';
import { aplicarModelo, variaveisDisponiveis } from '../servicos/modelo.js';

export const rotasWebhooks = Router();
export const rotasGatilho = Router();

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
  const modeloTitulo = String(req.body?.modelo_titulo || '').trim();
  const modeloTexto = String(req.body?.modelo_texto || '').trim();
  const tipo = TIPOS.includes(req.body?.tipo) ? req.body.tipo : 'lead';
  const publico = String(req.body?.publico || 'todos').trim();

  if (!nome) return res.status(400).json({ erro: 'Dê um nome ao webhook.' });
  if (!modeloTitulo || !modeloTexto) {
    return res.status(400).json({ erro: 'Preencha o modelo de título e de mensagem.' });
  }

  const info = db
    .prepare(
      `INSERT INTO webhooks (nome, slug, chave_secreta, modelo_titulo, modelo_texto, tipo, publico, criado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(nome, novoSlug(), novaChave(), modeloTitulo, modeloTexto, tipo, publico, req.usuario.id);

  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ webhook: comEndereco(webhook) });
});

rotasWebhooks.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const atual = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
  if (!atual) return res.status(404).json({ erro: 'Webhook não encontrado.' });

  const campos = {
    nome: req.body?.nome !== undefined ? String(req.body.nome).trim() : atual.nome,
    modelo_titulo:
      req.body?.modelo_titulo !== undefined
        ? String(req.body.modelo_titulo).trim()
        : atual.modelo_titulo,
    modelo_texto:
      req.body?.modelo_texto !== undefined
        ? String(req.body.modelo_texto).trim()
        : atual.modelo_texto,
    tipo: TIPOS.includes(req.body?.tipo) ? req.body.tipo : atual.tipo,
    publico: req.body?.publico !== undefined ? String(req.body.publico).trim() : atual.publico,
    ativo: req.body?.ativo !== undefined ? (req.body.ativo ? 1 : 0) : atual.ativo,
  };

  db.prepare(
    `UPDATE webhooks SET nome = ?, modelo_titulo = ?, modelo_texto = ?, tipo = ?, publico = ?, ativo = ?
      WHERE id = ?`
  ).run(
    campos.nome,
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

  const titulo = aplicarModelo(webhook.modelo_titulo, dados).trim() || webhook.nome;
  const texto =
    aplicarModelo(webhook.modelo_texto, dados).trim() || 'Evento recebido pelo webhook.';

  const resultado = await publicarNotificacao({
    titulo: titulo.slice(0, 120),
    texto: texto.slice(0, 500),
    tipo: webhook.tipo,
    origem: 'webhook',
    publico: webhook.publico,
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
