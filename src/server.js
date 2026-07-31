/**
 * Central de Notificações Push — Brokers Brasil
 * Servidor HTTP: serve o PWA e expõe a API.
 *
 * Em produção este processo escuta em HTTP na porta local e o Nginx
 * (ou Caddy) faz o TLS na frente. O push só funciona sob HTTPS.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';

import { config, RAIZ, validarConfig } from './config.js';
import { iniciarBanco } from './db/index.js';
import { configurarVapid } from './servicos/push.js';
import { carregarUsuario } from './middlewares/auth.js';

import { rotasAuth } from './rotas/auth.js';
import { rotasPush } from './rotas/push.js';
import { rotasNotificacoes } from './rotas/notificacoes.js';
import { rotasWebhooks, rotasGatilho } from './rotas/webhooks.js';
import { rotasUsuarios } from './rotas/usuarios.js';

// ── Checagem de configuração ────────────────────────────────────
const problemas = validarConfig();
if (problemas.length) {
  console.error('\n[configuração incompleta]');
  problemas.forEach((p) => console.error('  • ' + p));
  if (config.producao) {
    console.error('\nCorrija o .env antes de subir em produção.\n');
    process.exit(1);
  }
  console.error('  (seguindo mesmo assim porque o ambiente é de desenvolvimento)\n');
}

iniciarBanco();
const pushPronto = configurarVapid();

const app = express();

// Necessário atrás de proxy reverso para o rate limit ler o IP real.
if (config.confiarProxy) app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());

// Cabeçalhos de segurança básicos (sem dependência extra).
app.use((_req, res, proximo) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  proximo();
});

// Toda rota conhece o usuário logado (quando houver sessão).
app.use(carregarUsuario);

// ── API ─────────────────────────────────────────────────────────
app.use('/api/auth', rotasAuth);
app.use('/api/push', rotasPush);
app.use('/api/notificacoes', rotasNotificacoes);
app.use('/api/webhooks', rotasWebhooks);
app.use('/api/usuarios', rotasUsuarios);

// Endereço público dos gatilhos: https://seu-dominio/hook/<slug>
app.use('/hook', rotasGatilho);

/**
 * Diagnóstico rápido, aberto sem login.
 * A "versao" é o commit que gerou a imagem — abrir esta rota no navegador
 * é o jeito de confirmar que o deploy novo realmente subiu na VPS.
 */
app.get('/api/saude', (_req, res) => {
  res.json({
    ok: true,
    versao: config.versao,
    push: pushPronto,
    ambiente: config.ambiente,
  });
});

// ── PWA (arquivos estáticos) ────────────────────────────────────
const PUBLICO = path.join(RAIZ, 'public');

/**
 * O service worker precisa de escopo raiz e não pode ficar preso em cache,
 * senão o navegador continua rodando a versão antiga depois de um deploy.
 *
 * A versão da build é injetada no arquivo: assim o nome do cache muda a
 * cada deploy, o service worker novo assume e o antigo é descartado com
 * tudo que ele guardava. Sem isso, um deploy pode não aparecer para quem
 * já tinha o app aberto no celular.
 */
const swOriginal = fs.readFileSync(path.join(PUBLICO, 'sw.js'), 'utf8');
const swServido = swOriginal.replace("const VERSAO = 'bbr-v1'", `const VERSAO = 'bbr-${config.versao}'`);

app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  res.send(swServido);
});

/**
 * O iOS e alguns navegadores procuram estes arquivos direto na raiz,
 * ignorando as tags do HTML. Sem os atalhos abaixo eles receberiam o
 * index.html do app e mostrariam um ícone quebrado.
 */
const ATALHOS_ICONE = {
  '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png': 'apple-touch-icon.png',
  '/favicon.ico': 'favicon.ico',
  '/favicon.svg': 'favicon.svg',
};

for (const [rota, arquivo] of Object.entries(ATALHOS_ICONE)) {
  app.get(rota, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type(path.extname(arquivo));
    res.sendFile(path.join(PUBLICO, 'icones', arquivo));
  });
}

/**
 * Tudo é servido com "no-cache", que não significa "não guarde" e sim
 * "confirme comigo antes de reusar". Com o ETag, o navegador manda um
 * pedido curtinho e recebe 304 quando nada mudou — custo desprezível
 * para um app interno, e em troca todo deploy aparece na hora.
 *
 * Cache longo aqui já custou caro: uma alteração na tela de webhooks e o
 * favicon novo ficaram invisíveis porque o navegador segurava a versão
 * anterior por uma hora (e os ícones, por uma semana).
 */
app.use(
  express.static(PUBLICO, {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// Qualquer outra rota devolve o app (navegação por hash acontece no cliente).
app.get('*', (req, res, proximo) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/hook/')) return proximo();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLICO, 'index.html'));
});

// ── Erros ───────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

app.use((erro, _req, res, _proximo) => {
  console.error('[erro]', erro);
  res.status(erro.status || 500).json({ erro: 'Erro interno no servidor.' });
});

app.listen(config.porta, () => {
  console.log(`\n  Central de Notificações — Brokers Brasil`);
  console.log(`  ├─ versão   : ${config.versao}`);
  console.log(`  ├─ ambiente : ${config.ambiente}`);
  console.log(`  ├─ endereço : ${config.appUrl}`);
  console.log(`  ├─ porta    : ${config.porta}`);
  console.log(`  ├─ banco    : ${config.dbPath}`);
  console.log(`  └─ push     : ${pushPronto ? 'VAPID pronto' : 'SEM chaves VAPID'}\n`);
});
