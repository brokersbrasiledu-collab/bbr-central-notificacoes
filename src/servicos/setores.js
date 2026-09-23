/**
 * Setores — os times internos da empresa.
 *
 * Servem a dois propósitos:
 *   1. dizer de qual time é cada pessoa;
 *   2. permitir mandar um aviso só para um time, seja pelo público alvo
 *      de um envio, seja marcando uma categoria como sendo daquele setor.
 *
 * Tudo aqui é opcional. Setor nulo em qualquer lugar significa "como
 * sempre foi" — é o que mantém os webhooks já em produção intactos.
 */
import { db } from '../db/index.js';

/** Todos os setores, com quantas pessoas cada um tem. */
export function listarSetores() {
  return db
    .prepare(
      `SELECT s.id, s.nome, s.descricao, s.criado_em,
              (SELECT COUNT(*) FROM usuario_setores us
                 JOIN usuarios u ON u.id = us.usuario_id
                WHERE us.setor_id = s.id AND u.ativo = 1) AS pessoas,
              (SELECT COUNT(*) FROM tipos t WHERE t.setor_id = s.id) AS categorias
         FROM setores s
        ORDER BY s.nome COLLATE NOCASE`
    )
    .all();
}

export function buscarSetor(id) {
  const numero = Number(id);
  if (!Number.isInteger(numero)) return null;
  return db.prepare('SELECT * FROM setores WHERE id = ?').get(numero) || null;
}

/** Aceita id numérico ou nome — o webhook pode mandar qualquer um dos dois. */
export function resolverSetor(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const porId = buscarSetor(valor);
  if (porId) return porId;
  return (
    db.prepare('SELECT * FROM setores WHERE nome = ? COLLATE NOCASE').get(String(valor).trim()) ||
    null
  );
}

/**
 * Normaliza o que veio de um formulário para gravar em `setor_id`.
 * Vazio, "0" ou id inexistente viram null ("sem setor").
 */
export function setorIdValido(valor) {
  const setor = resolverSetor(valor);
  return setor ? setor.id : null;
}
