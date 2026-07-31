/**
 * Rotas de autenticação: entrar, sair e "quem sou eu".
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db } from '../db/index.js';
import { abrirSessao, fecharSessao, exigirLogin } from '../middlewares/auth.js';

export const rotasAuth = Router();

// Freia tentativa de adivinhar senha: 10 tentativas a cada 15 minutos por IP.
const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' },
});

rotasAuth.post('/login', limiteLogin, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const senha = String(req.body?.senha || '');

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Informe e-mail e senha.' });
  }

  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);

  // Mensagem genérica de propósito: não revela se o e-mail existe.
  const generico = { erro: 'E-mail ou senha incorretos.' };
  if (!usuario || !bcrypt.compareSync(senha, usuario.senha_hash)) {
    return res.status(401).json(generico);
  }
  if (!usuario.ativo) {
    return res.status(403).json({ erro: 'Esta conta está desativada.' });
  }

  db.prepare(`UPDATE usuarios SET ultimo_acesso_em = datetime('now') WHERE id = ?`).run(
    usuario.id
  );
  abrirSessao(res, usuario);

  return res.json({
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      nivel: usuario.nivel,
    },
  });
});

rotasAuth.post('/logout', (_req, res) => {
  fecharSessao(res);
  res.json({ ok: true });
});

/** Usado pelo PWA na abertura para saber se já existe sessão. */
rotasAuth.get('/eu', (req, res) => {
  if (!req.usuario) return res.status(401).json({ erro: 'Sem sessão.' });
  res.json({ usuario: req.usuario });
});

/** Troca da própria senha. Exige a senha atual. */
rotasAuth.post('/senha', exigirLogin, (req, res) => {
  const atual = String(req.body?.atual || '');
  const nova = String(req.body?.nova || '');

  if (nova.length < 8) {
    return res.status(400).json({ erro: 'A nova senha precisa ter ao menos 8 caracteres.' });
  }

  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.usuario.id);
  if (!bcrypt.compareSync(atual, usuario.senha_hash)) {
    return res.status(401).json({ erro: 'Senha atual incorreta.' });
  }

  db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(
    bcrypt.hashSync(nova, 12),
    usuario.id
  );
  res.json({ ok: true });
});
