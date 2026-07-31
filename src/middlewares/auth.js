/**
 * Sessão e controle de acesso.
 *
 * A sessão é um JWT guardado num cookie httpOnly — o JavaScript da página
 * não consegue ler o token, o que fecha a porta para roubo por XSS.
 */
import jwt from 'jsonwebtoken';
import { config, PESO_NIVEL } from '../config.js';
import { db } from '../db/index.js';

/** Gera o token e grava o cookie de sessão na resposta. */
export function abrirSessao(res, usuario) {
  const token = jwt.sign(
    { sub: usuario.id, nivel: usuario.nivel },
    config.jwtSegredo,
    { expiresIn: config.sessaoDuracao }
  );

  res.cookie(config.cookieNome, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.producao, // em HTTPS o cookie não trafega em claro
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: '/',
  });

  return token;
}

export function fecharSessao(res) {
  res.clearCookie(config.cookieNome, { path: '/' });
}

/**
 * Lê o cookie, valida o token e carrega o usuário do banco.
 * Não bloqueia: apenas preenche `req.usuario` quando houver sessão válida.
 * Isso permite rotas que se comportam diferente com e sem login.
 */
export function carregarUsuario(req, _res, proximo) {
  const token = req.cookies?.[config.cookieNome];
  if (!token) return proximo();

  try {
    const dados = jwt.verify(token, config.jwtSegredo);
    const usuario = db
      .prepare('SELECT id, nome, email, nivel, ativo FROM usuarios WHERE id = ?')
      .get(dados.sub);
    // Conta desativada ou apagada depois do login perde a sessão na hora.
    if (usuario && usuario.ativo) req.usuario = usuario;
  } catch {
    // Token inválido ou expirado: segue como visitante.
  }
  return proximo();
}

/** Bloqueia a rota para quem não está logado. */
export function exigirLogin(req, res, proximo) {
  if (!req.usuario) return res.status(401).json({ erro: 'Faça login para continuar.' });
  return proximo();
}

/**
 * Bloqueia a rota para quem não tem pelo menos o nível informado.
 * Hierarquia: admin (3) > operador (2) > membro (1).
 */
export function exigirNivel(nivelMinimo) {
  return (req, res, proximo) => {
    if (!req.usuario) return res.status(401).json({ erro: 'Faça login para continuar.' });
    if (PESO_NIVEL[req.usuario.nivel] < PESO_NIVEL[nivelMinimo]) {
      return res.status(403).json({ erro: 'Seu nível de acesso não permite esta ação.' });
    }
    return proximo();
  };
}
