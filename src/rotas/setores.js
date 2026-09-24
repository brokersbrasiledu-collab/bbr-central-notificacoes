/**
 * Setores — criação e manutenção dos times.
 *
 * Ler é liberado para quem está logado: a interface usa a lista para
 * mostrar de que time é cada pessoa e para montar os seletores de
 * público alvo. Criar, editar e excluir é só do administrador.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { exigirLogin, exigirNivel } from '../middlewares/auth.js';
import { listarSetores, buscarSetor } from '../servicos/setores.js';

export const rotasSetores = Router();

rotasSetores.get('/', exigirLogin, (_req, res) => {
  res.json({ itens: listarSetores() });
});

rotasSetores.post('/', exigirNivel('admin'), (req, res) => {
  const nome = String(req.body?.nome || '').trim();
  const descricao = String(req.body?.descricao || '').trim().slice(0, 140);

  if (!nome) return res.status(400).json({ erro: 'Dê um nome ao setor.' });
  if (nome.length > 40) {
    return res.status(400).json({ erro: 'O nome deve ter no máximo 40 caracteres.' });
  }

  const duplicado = db.prepare('SELECT id FROM setores WHERE nome = ? COLLATE NOCASE').get(nome);
  if (duplicado) return res.status(409).json({ erro: `Já existe um setor chamado "${nome}".` });

  const info = db
    .prepare('INSERT INTO setores (nome, descricao) VALUES (?, ?)')
    .run(nome, descricao);

  res.status(201).json({ setor: buscarSetor(info.lastInsertRowid) });
});

rotasSetores.patch('/:id', exigirNivel('admin'), (req, res) => {
  const atual = buscarSetor(req.params.id);
  if (!atual) return res.status(404).json({ erro: 'Setor não encontrado.' });

  const nome = req.body?.nome !== undefined ? String(req.body.nome).trim() : atual.nome;
  const descricao =
    req.body?.descricao !== undefined
      ? String(req.body.descricao).trim().slice(0, 140)
      : atual.descricao;

  if (!nome) return res.status(400).json({ erro: 'O nome não pode ficar vazio.' });

  const duplicado = db
    .prepare('SELECT id FROM setores WHERE nome = ? COLLATE NOCASE AND id != ?')
    .get(nome, atual.id);
  if (duplicado) return res.status(409).json({ erro: `Já existe um setor chamado "${nome}".` });

  db.prepare('UPDATE setores SET nome = ?, descricao = ? WHERE id = ?').run(
    nome,
    descricao,
    atual.id
  );
  res.json({ setor: buscarSetor(atual.id) });
});

/**
 * Excluir um setor não apaga ninguém e não interrompe envio nenhum.
 *
 * As pessoas e as categorias que apontavam para ele voltam a ficar "sem
 * setor", que é o estado de quem recebe tudo. Um webhook que mirava esse
 * setor passa a não encontrar ninguém, então a resposta avisa quantos
 * estão nessa situação antes de confirmar.
 */
rotasSetores.delete('/:id', exigirNivel('admin'), (req, res) => {
  const setor = buscarSetor(req.params.id);
  if (!setor) return res.status(404).json({ erro: 'Setor não encontrado.' });

  const pessoas = db
    .prepare('SELECT COUNT(*) AS n FROM usuario_setores WHERE setor_id = ?')
    .get(setor.id).n;
  // Webhooks e envios que miravam este setor ficariam sem destino.
  const alvo = `setor:${setor.id}`;
  const webhooks = db
    .prepare(`SELECT nome FROM webhooks WHERE publico = ? OR publico LIKE ?`)
    .all(alvo, `setor:%${setor.id}%`)
    .map((w) => w.nome);

  if (webhooks.length && req.query.confirmar !== 'sim') {
    return res.status(409).json({
      erro:
        `${webhooks.length} webhook(s) mandam avisos só para este setor: ` +
        `${webhooks.join(', ')}. Excluindo o setor, eles deixam de alcançar alguém. ` +
        `Mude o público desses webhooks antes, ou confirme para excluir assim mesmo.`,
      webhooks,
    });
  }

  // Os vínculos com pessoas somem em cascata.
  db.prepare('DELETE FROM setores WHERE id = ?').run(setor.id);

  res.json({ ok: true, pessoasSemSetor: pessoas });
});
