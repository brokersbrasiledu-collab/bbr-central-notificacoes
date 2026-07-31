#!/usr/bin/env node
/**
 * Aplica o schema do banco e cria o administrador inicial.
 * O servidor já faz isso ao subir; este script serve para rodar
 * separadamente num deploy ou conferir o banco sem iniciar o app.
 *
 *   npm run migrar
 */
import { iniciarBanco, db } from '../src/db/index.js';
import { config } from '../src/config.js';

iniciarBanco();

const tabelas = db
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
  .all()
  .map((t) => t.name);

console.log(`\n  Banco: ${config.dbPath}`);
console.log(`  Tabelas: ${tabelas.join(', ')}`);
console.log(
  `  Usuários cadastrados: ${db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n}\n`
);
