#!/usr/bin/env node
/**
 * Cria (ou promove) um administrador pela linha de comando.
 * Útil quando ninguém consegue mais entrar no painel.
 *
 *   npm run criar-admin -- "Nome" email@dominio.com senhaforte123
 */
import bcrypt from 'bcryptjs';
import { db, migrar } from '../src/db/index.js';

migrar();

const [nome, emailBruto, senha] = process.argv.slice(2);

if (!nome || !emailBruto || !senha) {
  console.error('\n  Uso: npm run criar-admin -- "Nome Completo" email@dominio.com senha\n');
  process.exit(1);
}
if (senha.length < 8) {
  console.error('\n  A senha precisa ter ao menos 8 caracteres.\n');
  process.exit(1);
}

const email = emailBruto.trim().toLowerCase();
const hash = bcrypt.hashSync(senha, 12);
const existente = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);

if (existente) {
  db.prepare(`UPDATE usuarios SET nome = ?, senha_hash = ?, nivel = 'admin', ativo = 1 WHERE id = ?`)
    .run(nome, hash, existente.id);
  console.log(`\n  ✓ Conta atualizada e promovida a administrador: ${email}\n`);
} else {
  db.prepare(`INSERT INTO usuarios (nome, email, senha_hash, nivel) VALUES (?, ?, ?, 'admin')`)
    .run(nome, email, hash);
  console.log(`\n  ✓ Administrador criado: ${email}\n`);
}
