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

/**
 * Bancos criados antes das categorias personalizadas travavam a coluna
 * "tipo" numa lista fixa (CHECK ... IN). Com essa trava, criar uma
 * categoria nova falharia na hora de gravar a primeira notificação.
 *
 * O SQLite não sabe remover um CHECK: é preciso recriar a tabela. O que
 * segue é o procedimento recomendado na documentação — tabela nova,
 * cópia dos dados, troca de nome, tudo dentro de uma transação, com as
 * chaves estrangeiras desligadas e conferidas no fim.
 */
const TABELAS_SEM_TRAVA = {
  webhooks: `
    CREATE TABLE webhooks_novo (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      nome             TEXT    NOT NULL,
      slug             TEXT    NOT NULL UNIQUE,
      chave_secreta    TEXT    NOT NULL,
      modo             TEXT    NOT NULL DEFAULT 'direto'
                         CHECK (modo IN ('direto', 'modelo')),
      modelo_titulo    TEXT    NOT NULL DEFAULT '',
      modelo_texto     TEXT    NOT NULL DEFAULT '',
      tipo             TEXT    NOT NULL DEFAULT 'lead',
      publico          TEXT    NOT NULL DEFAULT 'todos',
      ativo            INTEGER NOT NULL DEFAULT 1,
      criado_em        TEXT    NOT NULL DEFAULT (datetime('now')),
      criado_por       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      ultimo_disparo_em TEXT,
      total_disparos   INTEGER NOT NULL DEFAULT 0
    )`,

  notificacoes: `
    CREATE TABLE notificacoes_novo (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo      TEXT    NOT NULL,
      texto       TEXT    NOT NULL,
      tipo        TEXT    NOT NULL DEFAULT 'aviso',
      origem      TEXT    NOT NULL DEFAULT 'manual'
                    CHECK (origem IN ('manual', 'webhook', 'sistema')),
      webhook_id  INTEGER REFERENCES webhooks(id) ON DELETE SET NULL,
      criada_por  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      publico     TEXT    NOT NULL DEFAULT 'todos',
      payload     TEXT,
      entregues   INTEGER NOT NULL DEFAULT 0,
      falhas      INTEGER NOT NULL DEFAULT 0,
      criada_em   TEXT    NOT NULL DEFAULT (datetime('now'))
    )`,

  preferencias_tipo: `
    CREATE TABLE preferencias_tipo_novo (
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      tipo       TEXT    NOT NULL,
      PRIMARY KEY (usuario_id, tipo)
    )`,
};

function temTravaDeTipo(tabela) {
  const linha = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tabela);
  return Boolean(linha && /CHECK\s*\(\s*tipo\s+IN/i.test(linha.sql));
}

function removerTravasDeTipo() {
  const pendentes = Object.keys(TABELAS_SEM_TRAVA).filter(temTravaDeTipo);
  if (!pendentes.length) return;

  // PRAGMA não vale dentro de transação, por isso fica fora.
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    for (const tabela of pendentes) {
      const colunas = db
        .prepare(`PRAGMA table_info(${tabela})`)
        .all()
        .map((c) => `"${c.name}"`)
        .join(', ');

      db.exec(TABELAS_SEM_TRAVA[tabela]);
      db.exec(`INSERT INTO ${tabela}_novo (${colunas}) SELECT ${colunas} FROM ${tabela}`);
      db.exec(`DROP TABLE ${tabela}`);
      db.exec(`ALTER TABLE ${tabela}_novo RENAME TO ${tabela}`);
      console.log(`[migração] trava de tipo removida de ${tabela}`);
    }

    // O índice do histórico some junto com a tabela antiga.
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_notificacoes_data ON notificacoes(criada_em DESC, id DESC)'
    );

    const quebradas = db.pragma('foreign_key_check');
    if (quebradas.length) {
      throw new Error(`chaves estrangeiras inconsistentes: ${JSON.stringify(quebradas)}`);
    }

    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** Aplica o schema. Seguro de rodar quantas vezes quiser. */
export function migrar() {
  const sql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  db.exec(sql);
  ajustarColunas();
  removerTravasDeTipo();
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
