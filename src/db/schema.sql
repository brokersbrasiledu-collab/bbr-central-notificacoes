-- ────────────────────────────────────────────────────────────────
-- Central de Notificações Push — Brokers Brasil
-- Estrutura do banco (SQLite). É idempotente: pode rodar sempre.
-- ────────────────────────────────────────────────────────────────

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── usuarios ────────────────────────────────────────────────────
-- Contas do time. A senha nunca é guardada em texto puro: só o hash.
CREATE TABLE IF NOT EXISTS usuarios (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nome        TEXT    NOT NULL,
  email       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash  TEXT    NOT NULL,
  nivel       TEXT    NOT NULL DEFAULT 'membro'
                CHECK (nivel IN ('admin', 'operador', 'membro')),
  ativo       INTEGER NOT NULL DEFAULT 1,
  criado_em   TEXT    NOT NULL DEFAULT (datetime('now')),
  ultimo_acesso_em TEXT
);

-- ── aparelhos ───────────────────────────────────────────────────
-- Uma linha por celular/navegador inscrito no push. O trio
-- (endpoint, p256dh, auth) é a "subscription" devolvida pelo browser.
CREATE TABLE IF NOT EXISTS aparelhos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint      TEXT    NOT NULL UNIQUE,
  p256dh        TEXT    NOT NULL,
  auth          TEXT    NOT NULL,
  plataforma    TEXT,             -- "iOS", "Android", "Desktop"...
  user_agent    TEXT,
  criado_em     TEXT    NOT NULL DEFAULT (datetime('now')),
  ultimo_uso_em TEXT
);

CREATE INDEX IF NOT EXISTS idx_aparelhos_usuario ON aparelhos(usuario_id);

-- ── preferencias_tipo ───────────────────────────────────────────
-- O que cada pessoa NÃO quer receber no celular.
--
-- Guardar o que está silenciado (em vez do que está ligado) mantém o
-- padrão "recebe tudo": quem nunca abriu a tela de preferências, e quem
-- entrar no time amanhã, continua recebendo sem precisar configurar nada.
--
-- Silenciar afeta só o push. A notificação continua no histórico, que é
-- compartilhado por todo o time.
CREATE TABLE IF NOT EXISTS preferencias_tipo (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo       TEXT    NOT NULL,
  PRIMARY KEY (usuario_id, tipo)
);

-- ── tipos ───────────────────────────────────────────────────────
-- As categorias de notificação. Ficam em tabela, e não fixas no código,
-- porque o administrador cria as suas — e cada categoria nova aparece
-- sozinha na tela de preferências para o time ligar ou silenciar.
--
-- Nenhuma outra tabela declara CHECK sobre "tipo": uma lista fixa lá
-- impediria justamente a criação de categorias novas. A validação é
-- feita na aplicação, contra esta tabela.
CREATE TABLE IF NOT EXISTS tipos (
  chave       TEXT    PRIMARY KEY,   -- identificador curto, sem acento
  rotulo      TEXT    NOT NULL,      -- como aparece na tela
  descricao   TEXT    NOT NULL DEFAULT '',
  cor         TEXT    NOT NULL DEFAULT 'neutro'
                CHECK (cor IN ('ouro', 'vermelho', 'verde', 'azul', 'neutro')),
  -- Categorias de fábrica não podem ser excluídas: webhooks e integrações
  -- já criadas dependem delas.
  fixo        INTEGER NOT NULL DEFAULT 0,
  -- 'sistema' não é silenciável, senão o botão "enviar teste" pareceria
  -- quebrado para quem tivesse desligado.
  silenciavel INTEGER NOT NULL DEFAULT 1,
  ordem       INTEGER NOT NULL DEFAULT 100,
  criado_em   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Categorias de fábrica. INSERT OR IGNORE: quem já tem o banco criado
-- não perde as personalizações feitas nelas.
INSERT OR IGNORE INTO tipos (chave, rotulo, descricao, cor, fixo, silenciavel, ordem) VALUES
  ('lead',    'Lead',    'Lead novo entrando no funil',            'ouro',     1, 1, 10),
  ('meta',    'Meta',    'Meta batida, venda aprovada',            'verde',    1, 1, 20),
  ('alerta',  'Alerta',  'Automação parada, erro que precisa de atenção', 'vermelho', 1, 1, 30),
  ('aviso',   'Aviso',   'Comunicados do time',                    'neutro',   1, 1, 40),
  ('sistema', 'Sistema', 'Mensagens do próprio aplicativo',        'azul',     1, 0, 50);

-- ── webhooks ────────────────────────────────────────────────────
-- Gatilhos automáticos. Cada um tem um endereço único (slug), uma
-- chave secreta e o modelo de mensagem com variáveis dinâmicas.
CREATE TABLE IF NOT EXISTS webhooks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  nome             TEXT    NOT NULL,
  slug             TEXT    NOT NULL UNIQUE,
  chave_secreta    TEXT    NOT NULL,
  -- 'direto'  → o título e o texto vêm prontos no JSON (caso do n8n, que
  --             já resolveu as variáveis antes de chamar).
  -- 'modelo'  → o texto é montado aqui a partir de {{variaveis}}.
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
);

-- ── notificacoes ────────────────────────────────────────────────
-- Histórico. Toda notificação enviada (manual ou por webhook) vira
-- uma linha aqui, e é isso que alimenta a linha do tempo.
CREATE TABLE IF NOT EXISTS notificacoes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo      TEXT    NOT NULL,
  texto       TEXT    NOT NULL,
  tipo        TEXT    NOT NULL DEFAULT 'aviso',
  origem      TEXT    NOT NULL DEFAULT 'manual'
                CHECK (origem IN ('manual', 'webhook', 'sistema')),
  webhook_id  INTEGER REFERENCES webhooks(id) ON DELETE SET NULL,
  criada_por  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  publico     TEXT    NOT NULL DEFAULT 'todos',
  payload     TEXT,               -- JSON cru recebido no webhook (auditoria)
  entregues   INTEGER NOT NULL DEFAULT 0,
  falhas      INTEGER NOT NULL DEFAULT 0,
  criada_em   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notificacoes_data ON notificacoes(criada_em DESC, id DESC);
