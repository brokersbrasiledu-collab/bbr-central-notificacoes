#!/usr/bin/env node
/**
 * ETAPA 1 — Base do push.
 *
 * Gera o par de chaves VAPID. É a identidade do seu servidor perante o
 * Google e a Apple: uma vez gerado, o par é reusado para sempre.
 *
 * ATENÇÃO: trocar as chaves depois invalida TODAS as inscrições já feitas
 * — todo mundo precisaria reativar a notificação no celular.
 *
 *   npm run vapid
 */
import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAMINHO_ENV = path.join(RAIZ, '.env');

const chaves = webpush.generateVAPIDKeys();

console.log('\n  Chaves VAPID geradas\n');
console.log('  VAPID_PUBLIC_KEY=' + chaves.publicKey);
console.log('  VAPID_PRIVATE_KEY=' + chaves.privateKey);

// Se já existe um .env, tentamos preencher as chaves automaticamente —
// mas nunca sobrescrevemos chaves que já estejam lá.
if (fs.existsSync(CAMINHO_ENV)) {
  let env = fs.readFileSync(CAMINHO_ENV, 'utf8');
  const jaTem = /^VAPID_PUBLIC_KEY=.+$/m.test(env) && /^VAPID_PRIVATE_KEY=.+$/m.test(env);

  if (jaTem) {
    console.log(
      '\n  O .env já tem chaves VAPID preenchidas — nada foi alterado.\n' +
        '  Substitua manualmente apenas se souber que vai invalidar as inscrições atuais.\n'
    );
  } else {
    env = env.replace(/^VAPID_PUBLIC_KEY=.*$/m, `VAPID_PUBLIC_KEY=${chaves.publicKey}`);
    env = env.replace(/^VAPID_PRIVATE_KEY=.*$/m, `VAPID_PRIVATE_KEY=${chaves.privateKey}`);
    if (!/^VAPID_PUBLIC_KEY=/m.test(env)) {
      env += `\nVAPID_PUBLIC_KEY=${chaves.publicKey}\nVAPID_PRIVATE_KEY=${chaves.privateKey}\n`;
    }
    fs.writeFileSync(CAMINHO_ENV, env);
    console.log('\n  ✓ Chaves gravadas no .env\n');
  }
} else {
  console.log(
    '\n  Não encontrei um .env. Copie o .env.example para .env e cole as chaves acima.\n'
  );
}
