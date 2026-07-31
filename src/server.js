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

app.get('/api/saude', (_req, res) => {
  res.json({ ok: true, push: pushPronto, ambiente: config.ambiente });
});

// ── PWA (arquivos estáticos) ────────────────────────────────────
const PUBLICO = path.join(RAIZ, 'public');

/**
 * O service worker precisa de escopo raiz e não pode ficar preso em cache,
 * senão o navegador continua rodando a versão antiga depois de um deploy.
 */
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  res.sendFile(path.join(PUBLICO, 'sw.js'));
});

/**
 * O iOS e alguns navegadores procuram estes arquivos direto na raiz,
 * ignorando as tags do HTML. Sem os atalhos abaixo eles receberiam o
 * index.html do app e mostrariam um ícone quebrado.
 */
const ATALHOS_ICONE = {
  '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png': 'apple-touch-icon.png',
  '/favicon.ico': 'favicon-32.png',
};

for (const [rota, arquivo] of Object.entries(ATALHOS_ICONE)) {
  app.get(rota, (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type('image/png');
    res.sendFile(path.join(PUBLICO, 'icones', arquivo));
  });
}

app.use(
  express.static(PUBLICO, {
    etag: true,
    maxAge: config.producao ? '1h' : 0,
    setHeaders(res, arquivo) {
      // Ícones e imagens podem ficar muito tempo em cache.
      if (/\.(png|svg|ico|webp)$/.test(arquivo)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      }
      // O manifest e o HTML precisam ser revalidados sempre.
      if (/(manifest\.json|index\.html)$/.test(arquivo)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
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
  console.log(`  ├─ ambiente : ${config.ambiente}`);
  console.log(`  ├─ endereço : ${config.appUrl}`);
  console.log(`  ├─ porta    : ${config.porta}`);
  console.log(`  ├─ banco    : ${config.dbPath}`);
  console.log(`  └─ push     : ${pushPronto ? 'VAPID pronto' : 'SEM chaves VAPID'}\n`);
});
