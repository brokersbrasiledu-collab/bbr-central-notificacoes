/**
 * Conexão com o banco (SQLite via better-sqlite3).
 *
 * O schema é aplicado na importação — é idempotente, então subir o
 * servidor já garante que as tabelas existem.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

// Garante que a pasta do arquivo .db existe antes de abrir a conexão.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Ajustes de estrutura em bancos que já existem.
 *
 * O schema.sql usa CREATE TABLE IF NOT EXISTS, então ele não altera tabelas
 * já criadas. Colunas novas precisam ser adicionadas aqui, olhando antes se
 * já estão lá — assim o deploy em produção não perde nada.
 */
function ajustarColunas() {
  const tabelaExiste = (nome) =>
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(nome);

  if (!tabelaExiste('webhooks')) return;

  const colunas = db
    .prepare('PRAGMA table_info(webhooks)')
    .all()
    .map((c) => c.name);

  if (!colunas.includes('modo')) {
    // Webhooks que já existiam foram criados com modelo de variáveis:
    // eles continuam em 'modelo' para não mudarem de comportamento.
    // Os novos nascem em 'direto', que é o padrão do formulário.
    db.exec(`ALTER TABLE webhooks ADD COLUMN modo TEXT NOT NULL DEFAULT 'modelo'`);
    console.log("[migração] coluna 'modo' adicionada em webhooks");
  }
}

/** Aplica o schema. Seguro de rodar quantas vezes quiser. */
export function migrar() {
  const sql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  db.exec(sql);
  ajustarColunas();
}

/**
 * Cria o administrador inicial descrito no .env, se ainda não houver
 * nenhum admin no banco. Sem isso não haveria como entrar da primeira vez.
 */
export function semearAdmin() {
  const jaExiste = db
    .prepare(`SELECT COUNT(*) AS n FROM usuarios WHERE nivel = 'admin'`)
    .get().n;
  if (jaExiste > 0) return null;

  if (!config.admin.senha) {
    console.warn(
      '[aviso] Nenhum administrador no banco e ADMIN_SENHA não foi definido no .env.\n' +
        '        Defina ADMIN_EMAIL/ADMIN_SENHA e reinicie, ou rode "npm run criar-admin".'
    );
    return null;
  }

  const hash = bcrypt.hashSync(config.admin.senha, 12);
  db.prepare(
    `INSERT INTO usuarios (nome, email, senha_hash, nivel) VALUES (?, ?, ?, 'admin')`
  ).run(config.admin.nome, config.admin.email, hash);

  console.log(`[ok] Administrador inicial criado: ${config.admin.email}`);
  return config.admin.email;
}

/** Inicialização completa do banco (schema + admin inicial). */
export function iniciarBanco() {
  migrar();
  semearAdmin();
}
