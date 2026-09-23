/**
 * Gestão de contas e níveis de acesso — exclusivo do administrador.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { NIVEIS } from '../config.js';
import { exigirNivel } from '../middlewares/auth.js';
import { resolverSetor } from '../servicos/setores.js';

/**
 * Normaliza a lista de setores vinda do formulário.
 * Aceita ids ou nomes, descarta o que não existe e não repete.
 */
function idsDeSetores(valor) {
  const bruto = Array.isArray(valor) ? valor : valor === undefined ? null : [valor];
  if (!bruto) return null; // campo ausente = não mexer
  const ids = bruto
    .map((v) => resolverSetor(v)?.id)
    .filter((id) => Number.isInteger(id));
  return [...new Set(ids)];
}

/** Regrava os vínculos de uma pessoa de uma vez só. */
function gravarSetores(usuarioId, ids) {
  const aplicar = db.transaction(() => {
    db.prepare('DELETE FROM usuario_setores WHERE usuario_id = ?').run(usuarioId);
    const inserir = db.prepare(
      'INSERT OR IGNORE INTO usuario_setores (usuario_id, setor_id) VALUES (?, ?)'
    );
    for (const id of ids) inserir.run(usuarioId, id);
  });
  aplicar();
}

export const rotasUsuarios = Router();

rotasUsuarios.use(exigirNivel('admin'));

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

rotasUsuarios.get('/', (_req, res) => {
  const itens = db
    .prepare(
      `SELECT u.id, u.nome, u.email, u.nivel, u.ativo, u.criado_em, u.ultimo_acesso_em,
              (SELECT COUNT(*) FROM aparelhos a WHERE a.usuario_id = u.id) AS aparelhos,
              -- Ajuda o admin a entender por que alguém não recebeu um aviso.
              (SELECT COUNT(*) FROM preferencias_tipo p WHERE p.usuario_id = u.id) AS silenciados
         FROM usuarios u
        ORDER BY u.nivel = 'admin' DESC, u.nome COLLATE NOCASE`
    )
    .all();

  // Os setores de cada pessoa, numa consulta só para a tabela inteira.
  const vinculos = db
    .prepare(
      `SELECT us.usuario_id, s.id, s.nome
         FROM usuario_setores us
         JOIN setores s ON s.id = us.setor_id
        ORDER BY s.nome COLLATE NOCASE`
    )
    .all();

  for (const u of itens) {
    u.setores = vinculos.filter((v) => v.usuario_id === u.id).map((v) => ({ id: v.id, nome: v.nome }));
  }

  res.json({ itens });
});

rotasUsuarios.post('/', (req, res) => {
  const nome = String(req.body?.nome || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const senha = String(req.body?.senha || '');
  const nivel = NIVEIS.includes(req.body?.nivel) ? req.body.nivel : 'membro';

  if (!nome) return res.status(400).json({ erro: 'Informe o nome.' });
  if (!EMAIL_VALIDO.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
  if (senha.length < 8)
    return res.status(400).json({ erro: 'A senha precisa ter ao menos 8 caracteres.' });

  const duplicado = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (duplicado) return res.status(409).json({ erro: 'Já existe uma conta com este e-mail.' });

  // Setores são opcionais: lista vazia significa "sem setor", que recebe
  // tudo que não for específico de um time.
  const setores = idsDeSetores(req.body?.setores ?? req.body?.setor_id) || [];

  const info = db
    .prepare('INSERT INTO usuarios (nome, email, senha_hash, nivel) VALUES (?, ?, ?, ?)')
    .run(nome, email, bcrypt.hashSync(senha, 12), nivel);

  gravarSetores(info.lastInsertRowid, setores);

  const usuario = db
    .prepare('SELECT id, nome, email, nivel, ativo, criado_em FROM usuarios WHERE id = ?')
    .get(info.lastInsertRowid);
  res.status(201).json({ usuario });
});

rotasUsuarios.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const atual = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!atual) return res.status(404).json({ erro: 'Usuário não encontrado.' });

  const nome = req.body?.nome !== undefined ? String(req.body.nome).trim() : atual.nome;
  const nivel = NIVEIS.includes(req.body?.nivel) ? req.body.nivel : atual.nivel;
  const ativo = req.body?.ativo !== undefined ? (req.body.ativo ? 1 : 0) : atual.ativo;

  // Trava de segurança: o sistema não pode ficar sem nenhum admin ativo.
  const rebaixandoOuDesativando =
    (atual.nivel === 'admin' && nivel !== 'admin') || (atual.ativo === 1 && ativo === 0);
  if (rebaixandoOuDesativando && atual.nivel === 'admin') {
    const outros = db
      .prepare(`SELECT COUNT(*) AS n FROM usuarios WHERE nivel = 'admin' AND ativo = 1 AND id != ?`)
      .get(id).n;
    if (outros === 0) {
      return res
        .status(409)
        .json({ erro: 'É preciso manter ao menos um administrador ativo no sistema.' });
    }
  }

  db.prepare('UPDATE usuarios SET nome = ?, nivel = ?, ativo = ? WHERE id = ?').run(
    nome,
    nivel,
    ativo,
    id
  );

  // Só mexe nos setores se o campo veio na requisição: assim um PATCH que
  // troca apenas o nível não desvincula a pessoa dos times sem querer.
  const setores = idsDeSetores(req.body?.setores ?? req.body?.setor_id);
  if (setores) gravarSetores(id, setores);

  // Conta desativada não deve continuar recebendo push em aparelho antigo.
  if (!ativo) db.prepare('DELETE FROM aparelhos WHERE usuario_id = ?').run(id);

  const usuario = db
    .prepare('SELECT id, nome, email, nivel, ativo, criado_em FROM usuarios WHERE id = ?')
    .get(id);
  res.json({ usuario });
});

/** Define uma senha nova para outra conta (reset feito pelo admin). */
rotasUsuarios.post('/:id/senha', (req, res) => {
  const senha = String(req.body?.senha || '');
  if (senha.length < 8)
    return res.status(400).json({ erro: 'A senha precisa ter ao menos 8 caracteres.' });

  const info = db
    .prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(senha, 12), Number(req.params.id));
  if (!info.changes) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  res.json({ ok: true });
});

rotasUsuarios.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.usuario.id) {
    return res.status(409).json({ erro: 'Você não pode excluir a própria conta.' });
  }

  const alvo = db.prepare('SELECT nivel FROM usuarios WHERE id = ?').get(id);
  if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado.' });

  if (alvo.nivel === 'admin') {
    const outros = db
      .prepare(`SELECT COUNT(*) AS n FROM usuarios WHERE nivel = 'admin' AND ativo = 1 AND id != ?`)
      .get(id).n;
    if (outros === 0) {
      return res
        .status(409)
        .json({ erro: 'É preciso manter ao menos um administrador ativo no sistema.' });
    }
  }

  db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
  res.json({ ok: true });
});
