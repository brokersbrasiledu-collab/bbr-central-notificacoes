/**
 * Rotas do histórico (linha do tempo) e do envio manual de push.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { LIMITE_TITULO, LIMITE_TEXTO } from '../config.js';
import { tipoExiste } from '../servicos/tipos.js';
import { exigirLogin, exigirNivel } from '../middlewares/auth.js';
import { publicarNotificacao, aparelhosDoPublico } from '../servicos/push.js';
import { inicioDoDiaUTC } from '../servicos/datas.js';
import { resolverSetor } from '../servicos/setores.js';

export const rotasNotificacoes = Router();

/**
 * Linha do tempo — da mais recente para a mais antiga.
 *
 * Paginação por cursor (`antes=<id>`): mais estável que offset quando
 * chegam notificações novas enquanto o usuário rola a lista.
 */
const PERIODOS = { hoje: 0, '7d': 6, '30d': 29 };

/*
 * Quem enxerga qual notificação no histórico.
 *
 * A linha do tempo deixou de ser um mural único. A regra é o setor:
 *
 *   • em um ou mais setores → vê o que foi endereçado a esses setores
 *     (mais o que foi para todo o time, para o nível dela ou para ela);
 *   • em setor nenhum       → vê TUDO, a empresa inteira.
 *
 * O segundo caso é o que permite dar acompanhamento completo a alguém sem
 * precisar torná-la administradora: é só não colocar em setor algum.
 *
 * Abaixo está a condição do primeiro caso. Ela lê o mesmo campo `publico`
 * gravado junto da notificação, o mesmo que decide a entrega do push.
 *
 * Uma diferença de propósito: quem está em setor nenhum VÊ tudo aqui, mas
 * continua recebendo no celular só o que foi endereçado a ela. Histórico é
 * registro, push é interrupção — acompanhar a empresa inteira não deveria
 * significar o telefone tocando a cada lead de outro time.
 *
 * O campo guarda quatro formatos, e o SQL abaixo cobre os quatro:
 *
 *   'todos'            → todo mundo
 *   'setor:2,5'        → quem está em algum desses setores
 *   'admin,operador'   → quem tem algum desses níveis
 *   'usuarios:3,7'     → essas pessoas
 *
 * O truque do ',' || campo || ',' testa pertinência numa lista separada
 * por vírgula sem precisar de função extra do SQLite: procurar por
 * ",5," dentro de ",2,5," acerta o 5 e não confunde com 15 ou 51.
 *
 * Os padrões de busca são montados em JavaScript e entram prontos. Isso
 * não é estilo: o better-sqlite3 liga número de JS como REAL, então um id
 * 2 concatenado dentro do SQL viraria "2.0" e nunca casaria com ",2,".
 */
const SO_O_QUE_ME_CABE = `(
  n.publico = 'todos' OR n.publico = ''
  OR (
    n.publico LIKE 'setor:%'
    AND EXISTS (
      SELECT 1 FROM usuario_setores us
       WHERE us.usuario_id = ?
         AND (',' || substr(n.publico, 7) || ',') LIKE ('%,' || us.setor_id || ',%')
    )
  )
  OR (
    n.publico LIKE 'usuarios:%'
    AND (',' || substr(n.publico, 10) || ',') LIKE ?
  )
  OR (
    n.publico NOT LIKE 'setor:%'
    AND n.publico NOT LIKE 'usuarios:%'
    AND (',' || n.publico || ',') LIKE ?
  )
)`;

/**
 * Traduz os filtros da tela em condições de SQL.
 *
 * Fica separado porque a listagem e as ações em lote precisam recortar o
 * histórico exatamente do mesmo jeito: o que o administrador vê na tela é
 * o que ele vai mover ou apagar. Duas cópias dessa lógica seria pedir para
 * um dia elas divergirem e alguém apagar mais do que estava olhando.
 */
function filtrosDoHistorico(query) {
  const condicoes = [];
  const valores = [];

  if (tipoExiste(query.tipo)) {
    condicoes.push('n.tipo = ?');
    valores.push(query.tipo);
  }

  const busca = String(query.busca || '').trim().slice(0, 80);
  if (busca) {
    // Procura no título e no corpo: quem lembra de um trecho da mensagem
    // acha do mesmo jeito. O escape evita que % e _ digitados virem curinga.
    const termo = `%${busca.replace(/[%_\\]/g, '\\$&')}%`;
    condicoes.push(`(n.titulo LIKE ? ESCAPE '\\' OR n.texto LIKE ? ESCAPE '\\')`);
    valores.push(termo, termo);
  }

  if (Object.hasOwn(PERIODOS, query.periodo)) {
    condicoes.push('n.criada_em >= ?');
    valores.push(inicioDoDiaUTC(PERIODOS[query.periodo]));
  }

  // Filtrar pelo público é o que permite isolar o histórico antigo que
  // ainda está visível para todo mundo.
  const publico = String(query.publico || '').trim();
  if (publico) {
    condicoes.push('n.publico = ?');
    valores.push(publico);
  }

  return { condicoes, valores };
}

rotasNotificacoes.get('/', exigirLogin, (req, res) => {
  const limite = Math.min(Math.max(Number(req.query.limite) || 30, 1), 100);
  const antes = Number(req.query.antes) || null;

  /*
   * Quem não está em setor nenhum acompanha a empresa inteira — inclusive
   * sem ser administrador.
   *
   * O administrador que ESTÁ num setor vê o setor dele, como todo mundo.
   * Com ?escopo=tudo ele pede a visão completa, que é o que permite
   * conferir um envio ou apagar um teste de um setor do qual não faz parte.
   */
  const semSetor = !(req.usuario.setores || []).length;
  const adminPediuTudo = req.usuario.nivel === 'admin' && req.query.escopo === 'tudo';
  const verTudo = semSetor || adminPediuTudo;

  const condicoes = [];
  const valores = [];

  if (!verTudo) {
    condicoes.push(SO_O_QUE_ME_CABE);
    valores.push(req.usuario.id, `%,${req.usuario.id},%`, `%,${req.usuario.nivel},%`);
  }

  if (antes) {
    condicoes.push('n.id < ?');
    valores.push(antes);
  }

  const { condicoes: extras, valores: maisValores } = filtrosDoHistorico(req.query);
  condicoes.push(...extras);
  valores.push(...maisValores);

  const onde = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const itens = db
    .prepare(
      `SELECT n.id, n.titulo, n.texto, n.tipo, n.origem, n.publico,
              n.entregues, n.falhas, n.criada_em,
              u.nome AS autor, w.nome AS webhook
         FROM notificacoes n
         LEFT JOIN usuarios u ON u.id = n.criada_por
         LEFT JOIN webhooks w ON w.id = n.webhook_id
         ${onde}
        ORDER BY n.id DESC
        LIMIT ?`
    )
    .all(...valores, limite + 1);

  const temMais = itens.length > limite;
  res.json({ itens: itens.slice(0, limite), temMais, verTudo });
});

/**
 * Envio manual — admin e operador.
 * Grava no histórico e dispara o push de uma vez só.
 */
rotasNotificacoes.post('/enviar', exigirNivel('operador'), async (req, res) => {
  const titulo = String(req.body?.titulo || '').trim();
  const texto = String(req.body?.texto || '').trim();
  const tipo = tipoExiste(req.body?.tipo) ? req.body.tipo : 'aviso';
  const publico = String(req.body?.publico || 'todos').trim();

  if (!titulo) return res.status(400).json({ erro: 'O título é obrigatório.' });
  if (titulo.length > LIMITE_TITULO)
    return res
      .status(400)
      .json({ erro: `O título deve ter no máximo ${LIMITE_TITULO} caracteres.` });
  if (!texto) return res.status(400).json({ erro: 'A mensagem é obrigatória.' });
  if (texto.length > LIMITE_TEXTO)
    return res
      .status(400)
      .json({ erro: `A mensagem deve ter no máximo ${LIMITE_TEXTO} caracteres.` });

  const resultado = await publicarNotificacao({
    titulo,
    texto,
    tipo,
    origem: 'manual',
    publico,
    criadaPor: req.usuario.id,
  });

  res.status(201).json({
    ok: true,
    notificacao: resultado.notificacao,
    entregues: resultado.entregues,
    falhas: resultado.falhas,
    aparelhosAlvo: resultado.aparelhosAlvo,
  });
});

/**
 * Quantos aparelhos seriam atingidos por um público alvo.
 * A tela de envio usa isso para mostrar "chega em N aparelhos".
 */
rotasNotificacoes.get('/alcance', exigirNivel('operador'), (req, res) => {
  const publico = String(req.query.publico || 'todos');
  // O tipo importa no cálculo: quem silenciou aquele tipo não entra na conta.
  const tipo = tipoExiste(req.query.tipo) ? req.query.tipo : null;
  res.json({ aparelhos: aparelhosDoPublico(publico, tipo).length });
});

/**
 * Ações em lote sobre o que o filtro selecionou — só administrador.
 *
 * Existe porque o reprocessamento por webhook não alcança tudo: envio
 * manual não tem gatilho de onde tirar o setor, e aviso de webhook já
 * excluído perdeu a referência. Sem isto, esse resto só sairia apagando
 * linha por linha.
 *
 * Aqui o administrador filtra na tela, confere a contagem e então move
 * para um setor ou apaga. O recorte usado é o mesmo da listagem, então o
 * que ele viu é exatamente o que será afetado.
 *
 * Sem ?confirmar=sim devolve 409 com a contagem. Não há desfazer.
 */
function acaoEmLote(req, res, aplicar, descrever) {
  const { condicoes, valores } = filtrosDoHistorico(req.query);

  // Sem nenhum filtro a ação pegaria o histórico inteiro. Exigir ao menos
  // um recorte evita o clique distraído que apaga tudo.
  if (!condicoes.length) {
    return res.status(400).json({
      erro: 'Use ao menos um filtro antes de agir em lote — senão isto pegaria o histórico inteiro.',
    });
  }

  const onde = `WHERE ${condicoes.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM notificacoes n ${onde}`).get(...valores).n;

  if (!total) return res.json({ ok: true, afetadas: 0, semMudanca: true });

  if (req.query.confirmar !== 'sim') {
    return res.status(409).json({ erro: descrever(total), total });
  }

  res.json({ ok: true, afetadas: aplicar(onde, valores) });
}

/** Move para um setor tudo que o filtro selecionou. */
rotasNotificacoes.post('/mover-para-setor', exigirNivel('admin'), (req, res) => {
  const setor = resolverSetor(req.query.setor_id ?? req.body?.setor_id);
  if (!setor) return res.status(400).json({ erro: 'Escolha um setor de destino.' });

  return acaoEmLote(
    req,
    res,
    (onde, valores) =>
      db
        .prepare(`UPDATE notificacoes SET publico = ? WHERE id IN (SELECT n.id FROM notificacoes n ${onde})`)
        .run(`setor:${setor.id}`, ...valores).changes,
    (total) => `${total} aviso(s) vão passar a ser vistos só por quem é do setor ${setor.nome}.`
  );
});

/** Apaga tudo que o filtro selecionou. */
rotasNotificacoes.post('/excluir-em-lote', exigirNivel('admin'), (req, res) =>
  acaoEmLote(
    req,
    res,
    (onde, valores) =>
      db
        .prepare(`DELETE FROM notificacoes WHERE id IN (SELECT n.id FROM notificacoes n ${onde})`)
        .run(...valores).changes,
    (total) => `${total} aviso(s) serão apagados do histórico de todo mundo.`
  )
);

/** Apagar uma linha do histórico — só admin. */
rotasNotificacoes.delete('/:id', exigirNivel('admin'), (req, res) => {
  const info = db.prepare('DELETE FROM notificacoes WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ erro: 'Notificação não encontrada.' });
  res.json({ ok: true });
});
