/**
 * Categorias de notificação.
 *
 * Ler é liberado para quem está logado: a interface inteira depende disso
 * para saber os rótulos, as cores e o que oferecer nos filtros. Criar,
 * editar e excluir é só do administrador.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { exigirLogin, exigirNivel } from '../middlewares/auth.js';
import { listarTipos, buscarTipo, gerarChave, CORES } from '../servicos/tipos.js';

export const rotasTipos = Router();

rotasTipos.get('/', exigirLogin, (_req, res) => {
  res.json({ itens: listarTipos() });
});

/** Quantas notificações e webhooks usam a categoria. */
function usoDe(chave) {
  return {
    notificacoes: db
      .prepare('SELECT COUNT(*) AS n FROM notificacoes WHERE tipo = ?')
      .get(chave).n,
    webhooks: db.prepare('SELECT COUNT(*) AS n FROM webhooks WHERE tipo = ?').get(chave).n,
  };
}

rotasTipos.post('/', exigirNivel('admin'), (req, res) => {
  const rotulo = String(req.body?.rotulo || '').trim();
  const descricao = String(req.body?.descricao || '').trim().slice(0, 140);
  const cor = CORES.includes(req.body?.cor) ? req.body.cor : 'neutro';

  if (!rotulo) return res.status(400).json({ erro: 'Dê um nome à categoria.' });
  if (rotulo.length > 40) {
    return res.status(400).json({ erro: 'O nome deve ter no máximo 40 caracteres.' });
  }

  // A chave pode vir pronta (útil para casar com o que a integração já
  // manda) ou ser derivada do nome.
  const chave = gerarChave(req.body?.chave || rotulo);
  if (!chave) {
    return res.status(400).json({ erro: 'O nome precisa ter ao menos uma letra ou número.' });
  }
  if (buscarTipo(chave)) {
    return res.status(409).json({ erro: `Já existe uma categoria com a chave "${chave}".` });
  }

  // Entra no fim da lista, sem embaralhar a ordem das já existentes.
  const ultima = db.prepare('SELECT MAX(ordem) AS n FROM tipos').get().n || 0;

  db.prepare(
    `INSERT INTO tipos (chave, rotulo, descricao, cor, fixo, silenciavel, ordem)
     VALUES (?, ?, ?, ?, 0, 1, ?)`
  ).run(chave, rotulo, descricao, cor, ultima + 10);

  res.status(201).json({ tipo: buscarTipo(chave) });
});

rotasTipos.patch('/:chave', exigirNivel('admin'), (req, res) => {
  const atual = buscarTipo(req.params.chave);
  if (!atual) return res.status(404).json({ erro: 'Categoria não encontrada.' });

  const rotulo = req.body?.rotulo !== undefined ? String(req.body.rotulo).trim() : atual.rotulo;
  const descricao =
    req.body?.descricao !== undefined
      ? String(req.body.descricao).trim().slice(0, 140)
      : atual.descricao;
  const cor = CORES.includes(req.body?.cor) ? req.body.cor : atual.cor;

  if (!rotulo) return res.status(400).json({ erro: 'O nome não pode ficar vazio.' });

  // A chave nunca muda: ela já está gravada em cada notificação do
  // histórico e nos webhooks que as integrações disparam.
  db.prepare('UPDATE tipos SET rotulo = ?, descricao = ?, cor = ? WHERE chave = ?').run(
    rotulo,
    descricao,
    cor,
    atual.chave
  );

  res.json({ tipo: buscarTipo(atual.chave) });
});

/**
 * Exclui a categoria.
 *
 * Se ainda houver notificações ou webhooks usando, a resposta 409 diz
 * quantos são — a interface então pergunta para onde mover e repete a
 * chamada com ?mover_para=. Nada é apagado por tabela.
 */
rotasTipos.delete('/:chave', exigirNivel('admin'), (req, res) => {
  const tipo = buscarTipo(req.params.chave);
  if (!tipo) return res.status(404).json({ erro: 'Categoria não encontrada.' });
  if (tipo.fixo) {
    return res.status(409).json({
      erro: 'As categorias de fábrica não podem ser excluídas. Você pode renomeá-las.',
    });
  }

  const uso = usoDe(tipo.chave);
  const total = uso.notificacoes + uso.webhooks;
  const destino = req.query.mover_para ? buscarTipo(req.query.mover_para) : null;

  if (total > 0 && !destino) {
    return res.status(409).json({
      erro:
        `Esta categoria está em uso: ${uso.notificacoes} no histórico e ` +
        `${uso.webhooks} webhook(s). Escolha para onde mover antes de excluir.`,
      uso,
    });
  }

  const trocar = db.transaction(() => {
    if (destino) {
      db.prepare('UPDATE notificacoes SET tipo = ? WHERE tipo = ?').run(destino.chave, tipo.chave);
      db.prepare('UPDATE webhooks SET tipo = ? WHERE tipo = ?').run(destino.chave, tipo.chave);
    }
    // As preferências de quem silenciou esta categoria perdem o sentido.
    db.prepare('DELETE FROM preferencias_tipo WHERE tipo = ?').run(tipo.chave);
    db.prepare('DELETE FROM tipos WHERE chave = ?').run(tipo.chave);
  });
  trocar();

  res.json({ ok: true, movidos: destino ? total : 0 });
});
