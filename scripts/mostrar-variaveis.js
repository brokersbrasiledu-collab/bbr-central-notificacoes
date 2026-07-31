#!/usr/bin/env node
/**
 * Imprime o bloco de variáveis pronto para colar no painel do Portainer
 * (ou de qualquer outra hospedagem).
 *
 * Existe para você não precisar caçar o arquivo .env — que fica oculto
 * no Finder e guarda a chave privada do push.
 *
 *   npm run variaveis
 *   npm run variaveis -- https://avisos.seudominio.com.br
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAMINHO = path.join(RAIZ, '.env');

if (!fs.existsSync(CAMINHO)) {
  console.error(
    '\n  Não encontrei o arquivo .env.\n' +
      '  Rode primeiro:  cp .env.example .env  &&  npm run vapid\n'
  );
  process.exit(1);
}

// Leitura simples: uma variável por linha, ignorando comentários.
const env = Object.fromEntries(
  fs
    .readFileSync(CAMINHO, 'utf8')
    .split('\n')
    .filter((linha) => linha.trim() && !linha.trim().startsWith('#'))
    .map((linha) => {
      const corte = linha.indexOf('=');
      return [linha.slice(0, corte).trim(), linha.slice(corte + 1).trim()];
    })
);

const dominio = process.argv[2] || 'https://avisos.SEUDOMINIO.com.br';

// Segredo de sessão fraco ou de exemplo: gera um novo na hora.
const segredo =
  env.JWT_SECRET && env.JWT_SECRET.length >= 40 && !env.JWT_SECRET.startsWith('troque')
    ? env.JWT_SECRET
    : crypto.randomBytes(48).toString('hex');

// O Traefik roteia por nome de host, sem o "https://" e sem barra no fim.
const apenasHost = dominio.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

const linhas = [
  [
    'IMAGEM',
    process.env.IMAGEM ||
      'ghcr.io/brokersbrasiledu-collab/bbr-central-notificacoes:latest',
  ],
  ['APP_URL', dominio],
  ['DOMINIO', apenasHost],
  ['JWT_SECRET', segredo],
  ['VAPID_PUBLIC_KEY', env.VAPID_PUBLIC_KEY || '(faltando — rode: npm run vapid)'],
  ['VAPID_PRIVATE_KEY', env.VAPID_PRIVATE_KEY || '(faltando — rode: npm run vapid)'],
  ['VAPID_SUBJECT', env.VAPID_SUBJECT || 'mailto:contato@brokersbrasil.com.br'],
  ['ADMIN_NOME', env.ADMIN_NOME || 'Administrador'],
  ['ADMIN_EMAIL', env.ADMIN_EMAIL || 'voce@brokersbrasil.com.br'],
  ['ADMIN_SENHA', 'TROQUE-POR-UMA-SENHA-FORTE'],
];

console.log('\n  ┌─ Cole no Portainer, em "Environment variables" ─────────\n');
for (const [chave, valor] of linhas) console.log(`  ${chave}=${valor}`);
console.log('\n  └─────────────────────────────────────────────────────────\n');

console.log('  Antes de colar, ajuste duas linhas:');
console.log('    • IMAGEM      → o endereço que a aba Actions do GitHub mostrou');
console.log('                    (Passo 3 do PORTAINER.md)');
console.log('    • ADMIN_SENHA → sua senha de administrador\n');
console.log('  A VAPID_PRIVATE_KEY é secreta: não mande por WhatsApp nem por e-mail.');
console.log('  Guarde uma cópia — trocá-la obriga todo o time a reativar a');
console.log('  notificação no celular.\n');
