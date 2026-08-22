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
import { iniciarBanco, db } from './db/index.js';
import { configurarVapid } from './servicos/push.js';
import { carregarUsuario } from './middlewares/auth.js';

import { rotasAuth } from './rotas/auth.js';
import { rotasPush } from './rotas/push.js';
import { rotasNotificacoes } from './rotas/notificacoes.js';
import { rotasWebhooks, rotasGatilho } from './rotas/webhooks.js';
import { rotasUsuarios } from './rotas/usuarios.js';
import { rotasTipos } from './rotas/tipos.js';

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

/**
 * Se a preparação do banco falhar, o processo morre em laço de reinício.
 * A mensagem abaixo é o que aparece no log do Portainer — sem ela, sobra
 * só um rastro de pilha no meio de um container que reinicia sozinho.
 */
try {
  iniciarBanco();
} catch (erro) {
  console.error('\n[falha ao preparar o banco de dados]');
  console.error('  ' + (erro?.message || erro));
  console.error('\n  O arquivo fica em: ' + config.dbPath);
  console.error('  Faça uma cópia dele antes de qualquer tentativa de conserto.\n');
  process.exit(1);
}

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
app.use('/api/tipos', rotasTipos);

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
 * O index.html carimbado com a versão da build.
 *
 * As tags de <script> e <link> apontam para "/app.js?v=<versao>". A cada
 * deploy o endereço muda, então o navegador é obrigado a buscar o arquivo
 * novo — mesmo que ainda tenha o antigo guardado com validade longa.
 *
 * Sem isto, corrigir a política de cache não bastaria: a cópia antiga
 * continuaria valendo até vencer, e o deploy pareceria não ter funcionado.
 */
const comVersao = (arquivo) =>
  fs.readFileSync(path.join(PUBLICO, arquivo), 'utf8').replaceAll('__VERSAO__', config.versao);

const indexServido = comVersao('index.html');
const manifestServido = comVersao('manifest.json');

function enviarApp(_req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html');
  res.send(indexServido);
}

app.get('/', enviarApp);
app.get('/index.html', enviarApp);

// O manifest também carimbado: assim o endereço dos ícones muda a cada
// deploy e uma reinstalação não reaproveita o ícone antigo.
app.get('/manifest.json', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/manifest+json');
  res.send(manifestServido);
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
  return enviarApp(req, res);
});

// ── Erros ───────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

app.use((erro, _req, res, _proximo) => {
  console.error('[erro]', erro);
  res.status(erro.status || 500).json({ erro: 'Erro interno no servidor.' });
});

const servidor = app.listen(config.porta, () => {
  console.log(`\n  Central de Notificações — Brokers Brasil`);
  console.log(`  ├─ versão   : ${config.versao}`);
  console.log(`  ├─ ambiente : ${config.ambiente}`);
  console.log(`  ├─ endereço : ${config.appUrl}`);
  console.log(`  ├─ porta    : ${config.porta}`);
  console.log(`  ├─ banco    : ${config.dbPath}`);
  console.log(`  └─ push     : ${pushPronto ? 'VAPID pronto' : 'SEM chaves VAPID'}\n`);
});

/**
 * Desligamento limpo.
 *
 * Isto não é refinamento: dentro do container o Node é o PID 1, e o Linux
 * NÃO aplica a ação padrão de sinal ao PID 1. Sem um tratador explícito, o
 * SIGTERM que o Docker manda para parar o container é simplesmente
 * ignorado — o processo continua vivo até o prazo de carência acabar e
 * levar um SIGKILL, e o container termina com código 137.
 *
 * Esse 137 parece falha grave e não é: acontece em todo redeploy. Pior,
 * esconde as falhas de verdade, porque qualquer parada vira o mesmo código.
 *
 * Fechar o banco também importa: em modo WAL, o close consolida o arquivo
 * .wal no .db. Morrer de SIGKILL deixa esse trabalho para a próxima
 * abertura fazer sozinha.
 */
let desligando = false;

function desligar(sinal) {
  if (desligando) return;
  desligando = true;
  console.log(`\n  ${sinal} recebido — encerrando.`);

  // Rede de segurança: se alguma conexão não fechar, não fica pendurado
  // até o SIGKILL. unref() para este timer não segurar o processo vivo.
  const prazo = setTimeout(() => {
    console.error('  Conexões não fecharam a tempo. Encerrando à força.');
    process.exit(1);
  }, 8000);
  prazo.unref();

  servidor.close(() => {
    clearTimeout(prazo);
    try {
      db.close();
    } catch (erro) {
      console.error('  Aviso ao fechar o banco:', erro?.message || erro);
    }
    console.log('  Encerrado.\n');
    process.exit(0);
  });
}

process.on('SIGTERM', () => desligar('SIGTERM'));
process.on('SIGINT', () => desligar('SIGINT'));
