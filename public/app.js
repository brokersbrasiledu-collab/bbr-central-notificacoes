/* ════════════════════════════════════════════════════════════════
   Central de Notificações — Brokers Brasil
   Aplicação de página única, sem framework.

   Organização:
     1. Utilidades      — chamadas de API, escape, datas, avisos
     2. Ambiente        — detecção de iPhone / instalado / permissão
     3. Push            — service worker, permissão, inscrição
     4. Telas           — histórico, enviar, webhooks, acessos, aparelho
     5. Navegação       — roteador por hash e ciclo de login
   ════════════════════════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────────
// 1. Utilidades
// ─────────────────────────────────────────────────────────────

const $ = (seletor) => document.querySelector(seletor);

/** Chamada de API com cookie de sessão e erro já traduzido. */
async function api(caminho, opcoes = {}) {
  const resposta = await fetch(`/api${caminho}`, {
    credentials: 'include',
    headers: opcoes.corpo ? { 'Content-Type': 'application/json' } : undefined,
    method: opcoes.metodo || 'GET',
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });

  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = {};
  }

  if (!resposta.ok) {
    const erro = new Error(dados.erro || 'Não foi possível concluir a ação.');
    erro.status = resposta.status;
    throw erro;
  }
  return dados;
}

/**
 * Prepara a mensagem para exibição no histórico.
 *
 * Escapa primeiro (segurança) e só então converte o negrito *assim* —
 * o mesmo que se escreve no n8n ou no WhatsApp. As quebras de linha são
 * preservadas pelo CSS (white-space: pre-line).
 */
function formatarMensagem(texto) {
  return esc(texto).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
}

/** Impede que texto vindo do banco seja interpretado como HTML. */
function esc(valor) {
  return String(valor ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/**
 * O banco grava em UTC no formato "AAAA-MM-DD HH:MM:SS".
 * Aqui viram "há 5 min", "ontem 14:30" ou a data cheia.
 */
function quando(textoUtc) {
  const data = new Date(String(textoUtc).replace(' ', 'T') + 'Z');
  if (Number.isNaN(data.getTime())) return '';

  const minutos = Math.floor((Date.now() - data.getTime()) / 60000);
  if (minutos < 1) return 'agora';
  if (minutos < 60) return `há ${minutos} min`;

  const hora = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const hoje = new Date();
  const mesmoDia = data.toDateString() === hoje.toDateString();
  if (mesmoDia) return `hoje ${hora}`;

  const ontem = new Date(hoje);
  ontem.setDate(hoje.getDate() - 1);
  if (data.toDateString() === ontem.toDateString()) return `ontem ${hora}`;

  return `${data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hora}`;
}

/** Aviso rápido no rodapé. */
function avisar(mensagem, tipo = '') {
  const caixa = document.createElement('div');
  caixa.className = `aviso ${tipo ? `aviso--${tipo}` : ''}`;
  caixa.textContent = mensagem;
  $('#avisos').append(caixa);
  setTimeout(() => caixa.remove(), 4200);
}

async function copiar(texto, rotulo = 'Copiado') {
  try {
    await navigator.clipboard.writeText(texto);
    avisar(`${rotulo} para a área de transferência.`, 'ok');
  } catch {
    avisar('Não foi possível copiar. Selecione e copie manualmente.', 'erro');
  }
}

const ROTULO_TIPO = {
  lead: 'Lead',
  alerta: 'Alerta',
  meta: 'Meta',
  aviso: 'Aviso',
  sistema: 'Sistema',
};

const ROTULO_NIVEL = { admin: 'Administrador', operador: 'Operador', membro: 'Membro' };

function rotuloPublico(publico) {
  if (!publico || publico === 'todos') return 'Todo o time';
  if (publico.startsWith('usuarios:')) return 'Pessoas específicas';
  return publico
    .split(',')
    .map((n) => ROTULO_NIVEL[n.trim()] || n.trim())
    .join(' e ');
}

// ─────────────────────────────────────────────────────────────
// 2. Ambiente — iPhone, instalação e permissão
// ─────────────────────────────────────────────────────────────

const ua = navigator.userAgent;

const ambiente = {
  ehIOS:
    /iPad|iPhone|iPod/.test(ua) ||
    // iPad moderno se identifica como Mac; o toque entrega.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  ehAndroid: /Android/.test(ua),

  /** true quando o app foi aberto pelo ícone da tela inicial. */
  get instalado() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  },

  /**
   * No iPhone, o Safari só expõe PushManager depois que o site foi
   * salvo na tela inicial — por isso a checagem é dinâmica.
   */
  get suportaPush() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  },

  get permissao() {
    return 'Notification' in window ? Notification.permission : 'unsupported';
  },

  get plataforma() {
    if (this.ehIOS) return 'iOS';
    if (this.ehAndroid) return 'Android';
    return 'Desktop';
  },
};

// ─────────────────────────────────────────────────────────────
// 3. Push
// ─────────────────────────────────────────────────────────────

let registroSW = null;

/** A chave VAPID vem em base64url e o navegador exige Uint8Array. */
function chaveParaBytes(base64url) {
  const preenchimento = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + preenchimento).replace(/-/g, '+').replace(/_/g, '/');
  const cru = atob(base64);
  return Uint8Array.from([...cru].map((c) => c.charCodeAt(0)));
}

async function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    registroSW = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return registroSW;
  } catch (erro) {
    console.error('[pwa] falha ao registrar o service worker', erro);
    return null;
  }
}

/**
 * Cria a inscrição no serviço de push e manda para o backend.
 * Reaproveita a inscrição existente quando já houver uma.
 */
async function inscreverAparelho() {
  if (!registroSW) registroSW = await navigator.serviceWorker.ready;

  let inscricao = await registroSW.pushManager.getSubscription();
  if (!inscricao) {
    const { chave } = await api('/push/chave-publica');
    inscricao = await registroSW.pushManager.subscribe({
      userVisibleOnly: true, // exigido: todo push precisa virar notificação visível
      applicationServerKey: chaveParaBytes(chave),
    });
  }

  await api('/push/inscrever', {
    metodo: 'POST',
    corpo: { subscription: inscricao.toJSON(), plataforma: ambiente.plataforma },
  });

  return inscricao;
}

/**
 * Pede a permissão. PRECISA ser chamada dentro do handler de um clique —
 * navegadores ignoram o pedido feito fora de um gesto do usuário.
 */
async function ativarNotificacoes() {
  if (!ambiente.suportaPush) {
    avisar('Este navegador não suporta notificações push.', 'erro');
    return false;
  }

  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') {
    avisar('Permissão negada. Você não vai receber avisos neste aparelho.', 'erro');
    atualizarFaixa();
    return false;
  }

  try {
    await inscreverAparelho();
    avisar('Notificações ativadas neste aparelho.', 'ok');
    atualizarFaixa();
    return true;
  } catch (erro) {
    avisar(erro.message, 'erro');
    return false;
  }
}

/** Sincroniza a inscrição em silêncio quando a permissão já foi dada. */
async function sincronizarInscricao() {
  if (!ambiente.suportaPush || ambiente.permissao !== 'granted') return;
  try {
    await inscreverAparelho();
  } catch (erro) {
    console.warn('[push] não foi possível sincronizar a inscrição:', erro.message);
  }
}

/**
 * A faixa no topo. Ela é a implementação da regra do produto:
 * detectar → instruir → pedir → confirmar → sumir (ou insistir).
 */
function atualizarFaixa() {
  const faixa = $('#faixa-permissao');

  // 1. iPhone que ainda não salvou o app na tela inicial.
  if (ambiente.ehIOS && !ambiente.instalado) {
    faixa.hidden = false;
    faixa.innerHTML = `
      <div class="faixa__texto">
        <strong>Instale o app para receber os avisos</strong>
        <span>No iPhone, o push só funciona com o app salvo na tela inicial.</span>
        <ol>
          <li>Toque em <b>Compartilhar</b> na barra do Safari.</li>
          <li>Escolha <b>Adicionar à Tela de Início</b>.</li>
          <li>Abra o app pelo novo ícone e ative as notificações.</li>
        </ol>
      </div>`;
    return;
  }

  // 2. Navegador sem suporte (versão antiga, navegador embutido, etc).
  if (!ambiente.suportaPush) {
    faixa.hidden = false;
    faixa.innerHTML = `
      <div class="faixa__texto">
        <strong>Notificações indisponíveis neste navegador</strong>
        <span>Use o Chrome no Android ou o Safari no iPhone (iOS 16.4 ou mais novo).</span>
      </div>`;
    return;
  }

  // 3. Permissão recusada: o aviso fica na tela, como pedido.
  if (ambiente.permissao === 'denied') {
    faixa.hidden = false;
    faixa.innerHTML = `
      <div class="faixa__texto">
        <strong>Notificações bloqueadas</strong>
        <span>${
          ambiente.ehIOS
            ? 'Abra Ajustes › Notificações › BBR Avisos e libere as notificações.'
            : 'Abra as configurações do site no navegador e libere as notificações.'
        }</span>
      </div>`;
    return;
  }

  // 4. Falta pedir: botão para o toque do usuário.
  if (ambiente.permissao === 'default') {
    faixa.hidden = false;
    faixa.innerHTML = `
      <div class="faixa__texto">
        <strong>Ative as notificações</strong>
        <span>Sem isso, os avisos de lead e de automação não chegam neste aparelho.</span>
      </div>
      <button type="button" class="botao botao--principal" id="botao-ativar">Ativar agora</button>`;
    $('#botao-ativar').addEventListener('click', ativarNotificacoes);
    return;
  }

  // 5. Tudo certo — a faixa some.
  faixa.hidden = true;
  faixa.innerHTML = '';
}

// ─────────────────────────────────────────────────────────────
// 4. Telas
// ─────────────────────────────────────────────────────────────

const estado = {
  usuario: null,
  notificacoes: [],
  proximoCursor: null,
  temMais: false,
};

const podeEnviar = () => ['admin', 'operador'].includes(estado.usuario?.nivel);
const ehAdmin = () => estado.usuario?.nivel === 'admin';

/* ── Histórico ─────────────────────────────────────────────── */

/** Converte "AAAA-MM-DD HH:MM:SS" (UTC) numa Date local. */
const paraData = (utc) => new Date(String(utc).replace(' ', 'T') + 'Z');

/** Só a hora, que é o que interessa dentro de um dia já identificado. */
function horaDe(utc) {
  return paraData(utc).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Cabeçalho do grupo: "Hoje", "Ontem" ou "quinta-feira, 31 de julho". */
function rotuloDoDia(utc) {
  const data = paraData(utc);
  const hoje = new Date();
  const ontem = new Date();
  ontem.setDate(hoje.getDate() - 1);

  if (data.toDateString() === hoje.toDateString()) return 'Hoje';
  if (data.toDateString() === ontem.toDateString()) return 'Ontem';

  const texto = data.toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(data.getFullYear() !== hoje.getFullYear() ? { year: 'numeric' } : {}),
  });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/**
 * Um aviso da linha do tempo.
 *
 * Origem, público e contagem de entregas só aparecem para o administrador:
 * para quem só acompanha, é ruído em volta da mensagem.
 */
function cartaoAviso(n) {
  const origem =
    n.origem === 'webhook'
      ? `Webhook${n.webhook ? ` · ${esc(n.webhook)}` : ''}`
      : n.origem === 'manual'
        ? `Envio manual${n.autor ? ` · ${esc(n.autor)}` : ''}`
        : 'Sistema';

  const rodape = ehAdmin()
    ? `<div class="aviso__rodape">
         <span>${origem}</span>
         <span>${esc(rotuloPublico(n.publico))}</span>
         ${n.entregues ? `<span>${n.entregues} entregue(s)</span>` : ''}
       </div>`
    : '';

  return `
    <article class="aviso aviso--${esc(n.tipo)}">
      <div class="aviso__topo">
        <span class="etiqueta etiqueta--${esc(n.tipo)}">${esc(ROTULO_TIPO[n.tipo] || n.tipo)}</span>
        <time class="aviso__hora">${esc(horaDe(n.criada_em))}</time>
      </div>
      <h3 class="aviso__titulo">${esc(n.titulo)}</h3>
      <p class="aviso__texto">${formatarMensagem(n.texto)}</p>
      ${rodape}
    </article>`;
}

/** Quebra a lista em blocos por dia, mantendo a ordem que veio. */
function agruparPorDia(itens) {
  const grupos = [];
  for (const n of itens) {
    const rotulo = rotuloDoDia(n.criada_em);
    if (!grupos.length || grupos.at(-1).rotulo !== rotulo) grupos.push({ rotulo, itens: [] });
    grupos.at(-1).itens.push(n);
  }
  return grupos;
}

const filtros = { busca: '', tipo: '', periodo: '' };

function telaHistorico(container) {
  container.innerHTML = `
    <form class="filtros" id="filtros" role="search">
      <input
        type="search"
        id="f-busca"
        class="filtros__busca"
        placeholder="Buscar no título ou na mensagem"
        autocomplete="off"
        value="${esc(filtros.busca)}"
      />
      <select id="f-tipo" class="filtros__campo" aria-label="Filtrar por tipo">
        <option value="">Todos os tipos</option>
        ${TIPOS_FILTRO.map(
          ([valor, rotulo]) =>
            `<option value="${valor}" ${filtros.tipo === valor ? 'selected' : ''}>${rotulo}</option>`
        ).join('')}
      </select>
      <select id="f-periodo" class="filtros__campo" aria-label="Filtrar por período">
        <option value="">Qualquer data</option>
        <option value="hoje" ${filtros.periodo === 'hoje' ? 'selected' : ''}>Hoje</option>
        <option value="7d" ${filtros.periodo === '7d' ? 'selected' : ''}>Últimos 7 dias</option>
        <option value="30d" ${filtros.periodo === '30d' ? 'selected' : ''}>Últimos 30 dias</option>
      </select>
    </form>

    <div id="linha-tempo"></div>
    <div id="mais-area"></div>`;

  // A busca espera a digitação parar, para não disparar uma consulta por tecla.
  let temporizador;
  $('#f-busca').addEventListener('input', (evento) => {
    clearTimeout(temporizador);
    filtros.busca = evento.target.value;
    temporizador = setTimeout(() => carregarNotificacoes(true), 320);
  });

  $('#f-tipo').addEventListener('change', (e) => {
    filtros.tipo = e.target.value;
    carregarNotificacoes(true);
  });
  $('#f-periodo').addEventListener('change', (e) => {
    filtros.periodo = e.target.value;
    carregarNotificacoes(true);
  });

  return carregarNotificacoes(true);
}

const TIPOS_FILTRO = [
  ['lead', 'Leads'],
  ['meta', 'Metas'],
  ['alerta', 'Alertas'],
  ['aviso', 'Avisos'],
  ['sistema', 'Sistema'],
];

async function carregarNotificacoes(reiniciar = false) {
  const lista = $('#linha-tempo');
  const areaMais = $('#mais-area');
  if (!lista) return;

  if (reiniciar) estado.proximoCursor = null;

  const parametros = new URLSearchParams({ limite: '30' });
  if (!reiniciar && estado.proximoCursor) parametros.set('antes', estado.proximoCursor);
  if (filtros.busca.trim()) parametros.set('busca', filtros.busca.trim());
  if (filtros.tipo) parametros.set('tipo', filtros.tipo);
  if (filtros.periodo) parametros.set('periodo', filtros.periodo);

  try {
    const { itens, temMais } = await api(`/notificacoes?${parametros}`);
    estado.notificacoes = reiniciar ? itens : [...estado.notificacoes, ...itens];
    estado.temMais = temMais;
    estado.proximoCursor = estado.notificacoes.at(-1)?.id || null;

    if (!estado.notificacoes.length) {
      const filtrando = filtros.busca.trim() || filtros.tipo || filtros.periodo;
      lista.innerHTML = `<div class="vazio">${
        filtrando
          ? 'Nada encontrado com esses filtros.'
          : 'Nenhuma notificação por aqui ainda.'
      }</div>`;
      areaMais.innerHTML = '';
      return;
    }

    lista.innerHTML = agruparPorDia(estado.notificacoes)
      .map(
        (grupo) => `
        <section class="dia">
          <h2 class="dia__titulo">${esc(grupo.rotulo)}</h2>
          ${grupo.itens.map(cartaoAviso).join('')}
        </section>`
      )
      .join('');

    areaMais.innerHTML = temMais
      ? `<button type="button" class="botao" id="botao-mais">Carregar mais</button>`
      : '';
    $('#botao-mais')?.addEventListener('click', () => carregarNotificacoes(false));
  } catch (erro) {
    areaMais.innerHTML = `<p class="erro">${esc(erro.message)}</p>`;
  }
}

/* ── Enviar push ───────────────────────────────────────────── */

function telaEnviar(container) {
  container.innerHTML = `
    <form class="formulario" id="form-enviar">
      <div class="linha">
        <label class="campo">
          <span>Tipo</span>
          <select name="tipo">
            <option value="aviso">Aviso do time</option>
            <option value="lead">Lead</option>
            <option value="alerta">Alerta</option>
            <option value="meta">Meta</option>
          </select>
        </label>
        <label class="campo">
          <span>Público alvo</span>
          <select name="publico">
            <option value="todos">Todo o time</option>
            <option value="admin,operador">Administradores e operadores</option>
            <option value="admin">Somente administradores</option>
            <option value="operador">Somente operadores</option>
            <option value="membro">Somente membros</option>
          </select>
        </label>
      </div>

      <label class="campo">
        <span>Título</span>
        <input name="titulo" maxlength="120" required placeholder="Ex.: Reunião de alinhamento" />
      </label>

      <label class="campo">
        <span>Mensagem</span>
        <textarea name="texto" maxlength="500" required
          placeholder="Ex.: Começa às 9h na sala 2. Levem os números da semana."></textarea>
      </label>

      <p class="dica" id="alcance">Calculando alcance…</p>
      <p class="erro" id="erro-envio" hidden></p>

      <div class="cabecalho__acoes">
        <button type="submit" class="botao botao--principal">Enviar notificação</button>
        <button type="button" class="botao" id="botao-teste">Enviar teste para mim</button>
      </div>
    </form>`;

  const form = $('#form-enviar');
  const alcance = $('#alcance');

  /** Mostra quantos aparelhos serão atingidos pelo público escolhido. */
  async function atualizarAlcance() {
    try {
      const { aparelhos } = await api(
        `/notificacoes/alcance?publico=${encodeURIComponent(form.publico.value)}`
      );
      alcance.textContent =
        aparelhos === 0
          ? 'Nenhum aparelho ativo neste público — a notificação vai só para o histórico.'
          : `Chega em ${aparelhos} aparelho${aparelhos > 1 ? 's' : ''} agora.`;
    } catch {
      alcance.textContent = '';
    }
  }

  form.publico.addEventListener('change', atualizarAlcance);
  atualizarAlcance();

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const botao = form.querySelector('button[type=submit]');
    const erro = $('#erro-envio');
    erro.hidden = true;
    botao.disabled = true;
    botao.textContent = 'Enviando…';

    try {
      const resultado = await api('/notificacoes/enviar', {
        metodo: 'POST',
        corpo: {
          titulo: form.titulo.value,
          texto: form.texto.value,
          tipo: form.tipo.value,
          publico: form.publico.value,
        },
      });
      avisar(`Enviado para ${resultado.entregues} aparelho(s).`, 'ok');
      form.reset();
      atualizarAlcance();
    } catch (e) {
      erro.textContent = e.message;
      erro.hidden = false;
    } finally {
      botao.disabled = false;
      botao.textContent = 'Enviar notificação';
    }
  });

  $('#botao-teste').addEventListener('click', async () => {
    try {
      const r = await api('/push/teste', { metodo: 'POST' });
      avisar(`Teste enviado para ${r.entregues} aparelho(s).`, 'ok');
    } catch (e) {
      avisar(e.message, 'erro');
    }
  });
}

/* ── Webhooks ──────────────────────────────────────────────── */

/** Corpo de exemplo, no formato que o webhook espera. */
function corpoExemplo(w) {
  return w.modo === 'direto'
    ? `{
  "titulo": "✅ Venda aprovada",
  "texto": "A compra de {{ $json.customer.name }} foi confirmada.\\n\\n*Valor:* R$ {{ $json.value }}",
  "tipo": "${w.tipo}"
}`
    : `{
  "nome": "Maria Souza",
  "telefone": "11 90000-0000"
}`;
}

function cartaoWebhook(w) {
  const corpo = corpoExemplo(w);

  const comoUsar =
    w.modo === 'direto'
      ? `<p class="dica"><b>No n8n</b>, use um nó <b>HTTP Request</b>:</p>
         <ul class="passos">
           <li><b>Method</b> POST · <b>URL</b> o endereço acima</li>
           <li><b>Send Headers</b> ligado → <code>X-Chave-Secreta</code> = a chave acima</li>
           <li><b>Send Body</b> ligado → <b>JSON</b> → <b>Using JSON</b></li>
           <li>Cole o corpo abaixo e ligue a expressão <code>fx</code> no campo</li>
         </ul>`
      : `<p class="dica">
           Mande o JSON cru do seu sistema. Os campos alimentam as
           <code>{{variáveis}}</code> do modelo cadastrado.
         </p>`;

  const curl = `curl -X POST ${w.endereco} \\
  -H "X-Chave-Secreta: ${w.chave_secreta}" \\
  -H "Content-Type: application/json" \\
  -d '${corpo.replace(/\n\s*/g, ' ')}'`;

  return `
    <li class="item" data-id="${w.id}">
      <div class="item__topo">
        <div>
          <span class="item__nome">${esc(w.nome)}</span>
          ${w.ativo ? '' : '<span class="selo-inativo">Desativado</span>'}
          <div class="item__meta">
            <span>${w.modo === 'direto' ? 'JSON pronto' : 'Modelo com variáveis'}</span>
            <span>${esc(ROTULO_TIPO[w.tipo] || w.tipo)}</span>
            <span>${esc(rotuloPublico(w.publico))}</span>
            <span>${w.total_disparos} disparo(s)</span>
            <span>${w.ultimo_disparo_em ? `último ${esc(quando(w.ultimo_disparo_em))}` : 'nunca disparado'}</span>
          </div>
        </div>
        <div class="item__acoes">
          <button class="botao botao--pequeno" data-acao="usar">Como usar</button>
          <button class="botao botao--pequeno" data-acao="alternar">${w.ativo ? 'Desativar' : 'Ativar'}</button>
          <button class="botao botao--pequeno" data-acao="rotacionar">Nova chave</button>
          <button class="botao botao--pequeno botao--perigo" data-acao="excluir">Excluir</button>
        </div>
      </div>

      <div class="copiavel">
        <span class="copiavel__rotulo">URL</span>
        <code>${esc(w.endereco)}</code>
        <button class="botao botao--pequeno" data-acao="copiar-endereco">Copiar</button>
      </div>
      <div class="copiavel">
        <span class="copiavel__rotulo">Chave</span>
        <code>${esc(w.chave_secreta)}</code>
        <button class="botao botao--pequeno" data-acao="copiar-chave">Copiar</button>
      </div>

      <div class="instrucoes" data-usar hidden>
        ${comoUsar}
        <div class="bloco-codigo">
          <div class="bloco-codigo__topo">
            <span>Corpo da requisição</span>
            <button class="botao botao--pequeno" data-acao="copiar-corpo">Copiar</button>
          </div>
          <pre>${esc(corpo)}</pre>
        </div>
        <div class="bloco-codigo">
          <div class="bloco-codigo__topo">
            <span>Ou teste pelo terminal</span>
            <button class="botao botao--pequeno" data-acao="copiar-curl">Copiar</button>
          </div>
          <pre>${esc(curl)}</pre>
        </div>
      </div>
    </li>`;
}

async function telaWebhooks(container) {
  container.innerHTML = `
    <div class="bloco">
      <ul class="lista" id="lista-webhooks"></ul>
    </div>

    <div class="bloco">
      <button type="button" class="botao" id="abrir-novo">+ Novo gatilho</button>
    </div>

    <div class="bloco" id="area-novo" hidden>
      <h2>Novo gatilho</h2>
      <form class="formulario" id="form-webhook">
        <div class="linha">
          <label class="campo">
            <span>Nome</span>
            <input name="nome" required placeholder="Ex.: Lead novo do site" />
          </label>
          <label class="campo">
            <span>Tipo</span>
            <select name="tipo">
              <option value="lead">Lead</option>
              <option value="alerta">Alerta</option>
              <option value="meta">Meta</option>
              <option value="aviso">Aviso</option>
            </select>
          </label>
        </div>

        <label class="campo">
          <span>Público alvo</span>
          <select name="publico">
            <option value="todos">Todo o time</option>
            <option value="admin,operador">Administradores e operadores</option>
            <option value="admin">Somente administradores</option>
            <option value="operador">Somente operadores</option>
            <option value="membro">Somente membros</option>
          </select>
        </label>

        <label class="campo">
          <span>Como a mensagem chega</span>
          <select name="modo">
            <option value="direto">Já vem pronta no JSON — n8n, Make, Zapier</option>
            <option value="modelo">Montada aqui, com {{variáveis}}</option>
          </select>
        </label>

        <div id="ajuda-direto">
          <p class="dica">
            Mande <code>titulo</code> e <code>texto</code> no corpo da chamada. O
            título é o que aparece na tela do celular; o texto completo fica no
            histórico. Opcionalmente, <code>tipo</code> define a etiqueta.
            Dentro do texto, <code>\\n</code> quebra a linha e
            <code>*assim*</code> deixa em negrito.
          </p>
          <div class="bloco-codigo">
            <div class="bloco-codigo__topo"><span>Exemplo de corpo</span></div>
            <pre>{
  "titulo": "✅ Venda aprovada",
  "texto": "A compra de {{ $json.customer.name }} foi confirmada.\\n\\n*Valor:* R$ {{ $json.value }}",
  "tipo": "meta"
}</pre>
          </div>
        </div>

        <div id="campos-modelo" hidden>
          <label class="campo">
            <span>Modelo do título</span>
            <input name="modelo_titulo" value="Novo lead: {{nome}}" />
          </label>

          <label class="campo" style="margin-top:14px">
            <span>Modelo da mensagem</span>
            <textarea name="modelo_texto">{{nome}} chegou pelo {{origem}}. Telefone: {{telefone}}</textarea>
          </label>

          <p class="dica" style="margin-top:10px">
            Use <code>{{campo}}</code> para puxar qualquer valor do JSON recebido.
            Campos aninhados funcionam com ponto: <code>{{lead.nome}}</code>,
            <code>{{itens[0].valor}}</code>. Já vêm prontas:
            <code>{{agora}}</code>, <code>{{data}}</code>, <code>{{hora}}</code>.
          </p>
        </div>

        <p class="erro" id="erro-webhook" hidden></p>
        <button type="submit" class="botao botao--principal">Criar webhook</button>
      </form>
    </div>`;

  await carregarWebhooks();

  const form = $('#form-webhook');

  // O formulário nasce fechado: no dia a dia a tela serve para consultar
  // o endereço e a chave, não para criar gatilho.
  $('#abrir-novo').addEventListener('click', (evento) => {
    const area = $('#area-novo');
    area.hidden = !area.hidden;
    evento.target.textContent = area.hidden ? '+ Novo gatilho' : 'Cancelar';
    if (!area.hidden) area.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Mostra só o que interessa ao modo escolhido.
  const alternarModo = () => {
    const direto = form.modo.value === 'direto';
    $('#ajuda-direto').hidden = !direto;
    $('#campos-modelo').hidden = direto;
  };
  form.modo.addEventListener('change', alternarModo);
  alternarModo();

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const erro = $('#erro-webhook');
    erro.hidden = true;
    try {
      await api('/webhooks', {
        metodo: 'POST',
        corpo: {
          nome: form.nome.value,
          tipo: form.tipo.value,
          publico: form.publico.value,
          modo: form.modo.value,
          modelo_titulo: form.modelo_titulo.value,
          modelo_texto: form.modelo_texto.value,
        },
      });
      avisar('Webhook criado. Copie o endereço e a chave.', 'ok');
      form.reset();
      alternarModo(); // o reset volta o select ao padrão; a tela acompanha
      await carregarWebhooks();
    } catch (e) {
      erro.textContent = e.message;
      erro.hidden = false;
    }
  });
}

async function carregarWebhooks() {
  const lista = $('#lista-webhooks');
  const { itens } = await api('/webhooks');

  lista.innerHTML = itens.length
    ? itens.map(cartaoWebhook).join('')
    : `<div class="vazio">Nenhum gatilho criado ainda.</div>`;

  // Delegação: um só ouvinte cobre todos os botões da lista.
  lista.onclick = async (evento) => {
    const botao = evento.target.closest('[data-acao]');
    if (!botao) return;

    const item = botao.closest('.item');
    const id = Number(item.dataset.id);
    const webhook = itens.find((w) => w.id === id);
    const acao = botao.dataset.acao;

    try {
      if (acao === 'copiar-endereco') return copiar(webhook.endereco, 'Endereço copiado');
      if (acao === 'copiar-chave') return copiar(webhook.chave_secreta, 'Chave copiada');
      if (acao === 'copiar-corpo') return copiar(corpoExemplo(webhook), 'Corpo copiado');
      if (acao === 'copiar-curl') {
        return copiar(item.querySelectorAll('.bloco-codigo pre')[1].textContent, 'Comando copiado');
      }
      if (acao === 'usar') {
        const bloco = item.querySelector('[data-usar]');
        bloco.hidden = !bloco.hidden;
        botao.textContent = bloco.hidden ? 'Como usar' : 'Fechar';
        return;
      }
      if (acao === 'alternar') {
        await api(`/webhooks/${id}`, { metodo: 'PATCH', corpo: { ativo: !webhook.ativo } });
      }
      if (acao === 'rotacionar') {
        if (!confirm('Gerar uma chave nova? A chave atual para de funcionar na hora.')) return;
        await api(`/webhooks/${id}/rotacionar-chave`, { metodo: 'POST' });
        avisar('Chave rotacionada. Atualize na ferramenta que dispara o gatilho.', 'ok');
      }
      if (acao === 'excluir') {
        if (!confirm(`Excluir o webhook "${webhook.nome}"?`)) return;
        await api(`/webhooks/${id}`, { metodo: 'DELETE' });
      }
      await carregarWebhooks();
    } catch (e) {
      avisar(e.message, 'erro');
    }
  };
}

/* ── Acessos ───────────────────────────────────────────────── */

function cartaoUsuario(u, eu) {
  const opcoes = Object.entries(ROTULO_NIVEL)
    .map(
      ([valor, rotulo]) =>
        `<option value="${valor}" ${u.nivel === valor ? 'selected' : ''}>${rotulo}</option>`
    )
    .join('');

  return `
    <li class="item" data-id="${u.id}">
      <div class="item__topo">
        <div>
          <span class="item__nome">${esc(u.nome)}</span>
          ${u.ativo ? '' : '<span class="selo-inativo">Desativado</span>'}
          ${u.id === eu ? '<span class="selo-inativo">Você</span>' : ''}
          <div class="item__meta">
            <span>${esc(u.email)}</span>
            <span>${u.aparelhos} aparelho(s)</span>
            <span>${u.ultimo_acesso_em ? `entrou ${esc(quando(u.ultimo_acesso_em))}` : 'nunca entrou'}</span>
          </div>
        </div>
        <div class="item__acoes">
          <select data-acao="nivel" aria-label="Nível de acesso">${opcoes}</select>
          <button class="botao botao--pequeno" data-acao="alternar">${u.ativo ? 'Desativar' : 'Ativar'}</button>
          <button class="botao botao--pequeno" data-acao="senha">Nova senha</button>
          ${u.id === eu ? '' : '<button class="botao botao--pequeno botao--perigo" data-acao="excluir">Excluir</button>'}
        </div>
      </div>
    </li>`;
}

async function telaAcessos(container) {
  container.innerHTML = `
    <div class="bloco">
      <h2>Nova conta</h2>
      <form class="formulario" id="form-usuario">
        <div class="linha">
          <label class="campo">
            <span>Nome</span>
            <input name="nome" required placeholder="Nome completo" />
          </label>
          <label class="campo">
            <span>Nível</span>
            <select name="nivel">
              <option value="membro">Membro — recebe e acompanha</option>
              <option value="operador">Operador — envia push manual</option>
              <option value="admin">Administrador — acesso total</option>
            </select>
          </label>
        </div>
        <div class="linha">
          <label class="campo">
            <span>E-mail</span>
            <input name="email" type="email" required placeholder="pessoa@brokersbrasil.com.br" />
          </label>
          <label class="campo">
            <span>Senha inicial</span>
            <input name="senha" type="text" minlength="8" required placeholder="mínimo 8 caracteres" />
          </label>
        </div>
        <p class="erro" id="erro-usuario" hidden></p>
        <button type="submit" class="botao botao--principal">Criar conta</button>
      </form>
    </div>

    <div class="bloco">
      <h2>Contas do time</h2>
      <ul class="lista" id="lista-usuarios"></ul>
    </div>`;

  await carregarUsuarios();

  $('#form-usuario').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const form = evento.target;
    const erro = $('#erro-usuario');
    erro.hidden = true;
    try {
      await api('/usuarios', {
        metodo: 'POST',
        corpo: {
          nome: form.nome.value,
          email: form.email.value,
          senha: form.senha.value,
          nivel: form.nivel.value,
        },
      });
      avisar('Conta criada.', 'ok');
      form.reset();
      await carregarUsuarios();
    } catch (e) {
      erro.textContent = e.message;
      erro.hidden = false;
    }
  });
}

async function carregarUsuarios() {
  const lista = $('#lista-usuarios');
  const { itens } = await api('/usuarios');
  lista.innerHTML = itens.map((u) => cartaoUsuario(u, estado.usuario.id)).join('');

  const agir = async (elemento, acao) => {
    const item = elemento.closest('.item');
    const id = Number(item.dataset.id);
    const usuario = itens.find((u) => u.id === id);

    try {
      if (acao === 'nivel') {
        await api(`/usuarios/${id}`, { metodo: 'PATCH', corpo: { nivel: elemento.value } });
        avisar('Nível atualizado.', 'ok');
      }
      if (acao === 'alternar') {
        await api(`/usuarios/${id}`, { metodo: 'PATCH', corpo: { ativo: !usuario.ativo } });
      }
      if (acao === 'senha') {
        const senha = prompt(`Nova senha para ${usuario.nome} (mínimo 8 caracteres):`);
        if (!senha) return;
        await api(`/usuarios/${id}/senha`, { metodo: 'POST', corpo: { senha } });
        avisar('Senha redefinida.', 'ok');
      }
      if (acao === 'excluir') {
        if (!confirm(`Excluir a conta de ${usuario.nome}?`)) return;
        await api(`/usuarios/${id}`, { metodo: 'DELETE' });
      }
      await carregarUsuarios();
    } catch (e) {
      avisar(e.message, 'erro');
      await carregarUsuarios();
    }
  };

  lista.onclick = (evento) => {
    const botao = evento.target.closest('button[data-acao]');
    if (botao) agir(botao, botao.dataset.acao);
  };
  lista.onchange = (evento) => {
    const select = evento.target.closest('select[data-acao]');
    if (select) agir(select, select.dataset.acao);
  };
}

/* ── Este aparelho ─────────────────────────────────────────── */

async function telaAparelho(container) {
  const situacao = !ambiente.suportaPush
    ? ambiente.ehIOS && !ambiente.instalado
      ? 'Salve o app na tela inicial para liberar as notificações.'
      : 'Este navegador não suporta push.'
    : { granted: 'Ativadas', denied: 'Bloqueadas', default: 'Ainda não ativadas' }[
        ambiente.permissao
      ];

  container.innerHTML = `
    <div class="bloco">
      <div class="cartao">
        <div class="item__topo">
          <div>
            <span class="item__nome">Notificações neste aparelho</span>
            <div class="item__meta">
              <span>${esc(situacao)}</span>
              <span>${ambiente.plataforma}</span>
              <span>${ambiente.instalado ? 'Instalado na tela inicial' : 'Aberto no navegador'}</span>
            </div>
          </div>
          <div class="item__acoes">
            ${
              ambiente.suportaPush && ambiente.permissao !== 'granted'
                ? '<button class="botao botao--principal botao--pequeno" id="ativar-aqui">Ativar</button>'
                : ''
            }
            ${
              ambiente.permissao === 'granted'
                ? '<button class="botao botao--pequeno" id="testar-aqui">Enviar teste</button>'
                : ''
            }
          </div>
        </div>
      </div>
    </div>

    <div class="bloco">
      <h2>Aparelhos inscritos na sua conta</h2>
      <ul class="lista" id="lista-aparelhos"></ul>
    </div>

    <div class="bloco">
      <h2>Trocar minha senha</h2>
      <form class="formulario" id="form-senha">
        <div class="linha">
          <label class="campo">
            <span>Senha atual</span>
            <input name="atual" type="password" autocomplete="current-password" required />
          </label>
          <label class="campo">
            <span>Nova senha</span>
            <input name="nova" type="password" autocomplete="new-password" minlength="8" required />
          </label>
        </div>
        <p class="erro" id="erro-senha" hidden></p>
        <button type="submit" class="botao">Salvar nova senha</button>
      </form>
    </div>`;

  $('#ativar-aqui')?.addEventListener('click', async () => {
    if (await ativarNotificacoes()) irPara('#/aparelho');
  });

  $('#testar-aqui')?.addEventListener('click', async () => {
    try {
      const r = await api('/push/teste', { metodo: 'POST' });
      avisar(`Teste enviado para ${r.entregues} aparelho(s).`, 'ok');
    } catch (e) {
      avisar(e.message, 'erro');
    }
  });

  try {
    const { aparelhos } = await api('/push/meus-aparelhos');
    $('#lista-aparelhos').innerHTML = aparelhos.length
      ? aparelhos
          .map(
            (a) => `
        <li class="item">
          <div class="item__topo">
            <div>
              <span class="item__nome">${esc(a.plataforma || 'Aparelho')}</span>
              <div class="item__meta">
                <span>inscrito ${esc(quando(a.criado_em))}</span>
                <span>${a.ultimo_uso_em ? `visto ${esc(quando(a.ultimo_uso_em))}` : ''}</span>
              </div>
            </div>
          </div>
        </li>`
          )
          .join('')
      : `<div class="vazio">Nenhum aparelho inscrito ainda.</div>`;
  } catch {
    $('#lista-aparelhos').innerHTML = '';
  }

  $('#form-senha').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const form = evento.target;
    const erro = $('#erro-senha');
    erro.hidden = true;
    try {
      await api('/auth/senha', {
        metodo: 'POST',
        corpo: { atual: form.atual.value, nova: form.nova.value },
      });
      avisar('Senha alterada.', 'ok');
      form.reset();
    } catch (e) {
      erro.textContent = e.message;
      erro.hidden = false;
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 5. Navegação
// ─────────────────────────────────────────────────────────────

const ICONES = {
  historico: '<path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/>',
  enviar: '<path d="M4 12l16-8-6 16-2.5-6.5L4 12z"/>',
  webhooks: '<path d="M12 3v6"/><circle cx="12" cy="12" r="3"/><path d="M5 20a7 7 0 0 1 3-9"/><path d="M19 20a7 7 0 0 0-3-9"/>',
  acessos: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M17 8h4"/><path d="M19 6v4"/>',
  aparelho: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
};

const TELAS = {
  historico: {
    titulo: 'Histórico',
    subtitulo: 'Tudo que foi disparado, do mais recente para o mais antigo.',
    render: telaHistorico,
    nivel: 'membro',
  },
  enviar: {
    titulo: 'Enviar push',
    subtitulo: 'Monte a mensagem e escolha quem recebe.',
    render: telaEnviar,
    nivel: 'operador',
  },
  webhooks: {
    titulo: 'Webhooks',
    subtitulo: 'Gatilhos automáticos disparados por ferramentas externas.',
    render: telaWebhooks,
    nivel: 'admin',
  },
  acessos: {
    titulo: 'Acessos',
    subtitulo: 'Contas do time e níveis de permissão.',
    render: telaAcessos,
    nivel: 'admin',
  },
  aparelho: {
    titulo: 'Este aparelho',
    subtitulo: 'Notificações, aparelhos inscritos e sua senha.',
    render: telaAparelho,
    nivel: 'membro',
  },
};

const PESO = { admin: 3, operador: 2, membro: 1 };
const temAcesso = (chave) => PESO[estado.usuario?.nivel] >= PESO[TELAS[chave].nivel];

const NOME_MENU = {
  historico: 'Histórico',
  enviar: 'Enviar',
  webhooks: 'Webhooks',
  acessos: 'Acessos',
  aparelho: 'Aparelho',
};

function montarMenu() {
  const menu = $('#menu');
  menu.innerHTML = Object.keys(TELAS)
    .filter(temAcesso)
    .map(
      (chave) => `
      <li>
        <button type="button" data-tela="${chave}">
          <svg viewBox="0 0 24 24" aria-hidden="true">${ICONES[chave]}</svg>
          <span>${NOME_MENU[chave]}</span>
        </button>
      </li>`
    )
    .join('');

  menu.onclick = (evento) => {
    const botao = evento.target.closest('button[data-tela]');
    if (botao) irPara(`#/${botao.dataset.tela}`);
  };
}

const irPara = (hash) => {
  if (location.hash === hash) rotear();
  else location.hash = hash;
};

async function rotear() {
  if (!estado.usuario) return;

  let chave = (location.hash.replace(/^#\/?/, '') || 'historico').split('?')[0];
  if (!TELAS[chave] || !temAcesso(chave)) chave = 'historico';

  const tela = TELAS[chave];
  $('#titulo-tela').textContent = tela.titulo;
  $('#subtitulo-tela').textContent = tela.subtitulo;
  $('#acoes-tela').innerHTML = '';

  document.querySelectorAll('#menu button').forEach((b) => {
    if (b.dataset.tela === chave) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });

  const container = $('#tela');
  container.innerHTML = '';
  try {
    await tela.render(container);
  } catch (erro) {
    if (erro.status === 401) return encerrarSessao();
    container.innerHTML = `<p class="erro">${esc(erro.message)}</p>`;
  }
}

/* ── Login / sessão ────────────────────────────────────────── */

function mostrarLogin() {
  $('#tela-login').hidden = false;
  $('#app').hidden = true;
}

async function entrarNoApp(usuario) {
  estado.usuario = usuario;
  $('#tela-login').hidden = true;
  $('#app').hidden = false;

  $('#usuario-atual').querySelector('.usuario__nome').textContent = usuario.nome;
  $('#usuario-atual').querySelector('.usuario__nivel').textContent =
    ROTULO_NIVEL[usuario.nivel] || usuario.nivel;

  montarMenu();
  atualizarFaixa();
  await rotear();

  // Com a permissão já concedida, garante que este aparelho está no banco.
  sincronizarInscricao();
}

function encerrarSessao() {
  estado.usuario = null;
  mostrarLogin();
}

$('#form-login').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const form = evento.target;
  const erro = $('#erro-login');
  const botao = form.querySelector('button[type=submit]');
  erro.hidden = true;
  botao.disabled = true;
  botao.textContent = 'Entrando…';

  try {
    const { usuario } = await api('/auth/login', {
      metodo: 'POST',
      corpo: { email: form.email.value, senha: form.senha.value },
    });
    form.reset();
    await entrarNoApp(usuario);
  } catch (e) {
    erro.textContent = e.message;
    erro.hidden = false;
  } finally {
    botao.disabled = false;
    botao.textContent = 'Entrar';
  }
});

$('#botao-sair').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { metodo: 'POST' });
  } catch {
    /* mesmo com falha de rede, sai da interface */
  }
  encerrarSessao();
});

window.addEventListener('hashchange', rotear);

/**
 * Mantém a linha do tempo fresca: ao voltar para o app e a cada 45 s.
 * Barato o bastante para um time pequeno, e evita o usuário ter de recarregar.
 */
function manterAtualizado() {
  const atualizarSeNoHistorico = () => {
    if (!estado.usuario) return;
    if (document.hidden) return;
    if (!location.hash.includes('historico') && location.hash !== '' && location.hash !== '#/')
      return;
    carregarNotificacoes(true);
  };

  document.addEventListener('visibilitychange', atualizarSeNoHistorico);
  setInterval(atualizarSeNoHistorico, 45000);

  // O service worker avisa quando o usuário abriu o app pela notificação.
  navigator.serviceWorker?.addEventListener('message', (evento) => {
    if (evento.data?.tipo === 'notificacao-aberta') {
      irPara('#/historico');
      atualizarSeNoHistorico();
    }
  });
}

/* ── Início ────────────────────────────────────────────────── */

(async function iniciar() {
  // Sem await de propósito: o registro do service worker pode demorar
  // (ou nem completar em navegadores restritos) e não deve segurar a
  // primeira pintura da tela. A inscrição no push espera por ele depois.
  registrarServiceWorker();
  manterAtualizado();

  try {
    const { usuario } = await api('/auth/eu');
    await entrarNoApp(usuario);
  } catch {
    mostrarLogin();
  }
})();
