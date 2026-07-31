/* ────────────────────────────────────────────────────────────────
   Service worker — Central de Notificações Brokers Brasil

   Três papéis:
   1. Receber o push e mostrar a notificação nativa (mesmo com o app
      fechado — é o navegador que acorda este arquivo, não a página).
   2. Levar o usuário à linha do tempo quando ele toca na notificação.
   3. Guardar a casca do app em cache para abrir rápido e offline.
   ──────────────────────────────────────────────────────────────── */

const VERSAO = 'bbr-v1';
// O app.js e o estilos.css NÃO entram aqui: eles são pedidos com "?v=versao"
// e o próprio interceptador de rede guarda a versão certa quando ela chega.
// Listá-los sem a versão só encheria o cache com um arquivo que ninguém pede.
const CASCA = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icones/marca.png', // logo da interface
  '/icones/icone-192.png', // usada na própria notificação
];

// ── Ciclo de vida ───────────────────────────────────────────────

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches
      .open(VERSAO)
      // addAll falha inteiro se um arquivo faltar; add individual é tolerante.
      .then((cache) => Promise.allSettled(CASCA.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((chaves) =>
        Promise.all(chaves.filter((c) => c !== VERSAO).map((c) => caches.delete(c)))
      )
      .then(() => self.clients.claim())
  );
});

// ── Rede ────────────────────────────────────────────────────────

/**
 * Só a casca estática passa pelo cache. Chamadas de API e de gatilho
 * vão sempre à rede — histórico velho em cache seria pior que erro.
 */
self.addEventListener('fetch', (evento) => {
  const req = evento.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hook/')) return;

  evento.respondWith(
    fetch(req)
      .then((resposta) => {
        // Guarda a versão nova para a próxima abertura sem rede.
        if (resposta.ok && resposta.type === 'basic') {
          const copia = resposta.clone();
          caches.open(VERSAO).then((cache) => cache.put(req, copia));
        }
        return resposta;
      })
      .catch(async () => {
        const emCache = await caches.match(req);
        if (emCache) return emCache;
        // Navegação sem rede e sem cache exato: devolve a casca do app.
        if (req.mode === 'navigate') return caches.match('/index.html');
        return new Response('Sem conexão.', { status: 503 });
      })
  );
});

// ── Push ────────────────────────────────────────────────────────

const ROTULO_TIPO = {
  lead: 'Novo lead',
  alerta: 'Alerta',
  meta: 'Meta',
  aviso: 'Aviso',
  sistema: 'Sistema',
};

self.addEventListener('push', (evento) => {
  let dados = {};
  try {
    dados = evento.data ? evento.data.json() : {};
  } catch {
    // Payload não-JSON (raro): usa o texto puro como corpo.
    dados = { titulo: 'Brokers Brasil', texto: evento.data ? evento.data.text() : '' };
  }

  const titulo = dados.titulo || 'Brokers Brasil';
  const opcoes = {
    body: dados.texto || '',
    icon: '/icones/icone-192.png',
    badge: '/icones/icone-192.png',
    // Vibração curta: chama atenção sem incomodar.
    vibrate: [80, 40, 80],
    // tag por tipo agrupa avisos da mesma natureza; renotify garante
    // que uma mensagem nova ainda alerte mesmo reusando a tag.
    tag: `bbr-${dados.tipo || 'aviso'}`,
    renotify: true,
    timestamp: dados.criada_em ? Date.parse(dados.criada_em) : Date.now(),
    data: {
      url: dados.url || '/#/historico',
      id: dados.id || null,
      tipo: dados.tipo || 'aviso',
    },
    // No iOS as ações não aparecem, mas não atrapalham.
    actions: [{ action: 'abrir', title: 'Abrir histórico' }],
  };

  if (ROTULO_TIPO[dados.tipo]) {
    // Prefixo discreto ajuda a bater o olho e entender a origem.
    opcoes.body = opcoes.body || ROTULO_TIPO[dados.tipo];
  }

  evento.waitUntil(self.registration.showNotification(titulo, opcoes));
});

/** Tocar na notificação abre o app já na linha do tempo. */
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const destino = evento.notification.data?.url || '/#/historico';

  evento.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      // Se o app já está aberto, reaproveita a janela em vez de abrir outra.
      for (const janela of janelas) {
        if (janela.url.includes(self.location.origin) && 'focus' in janela) {
          janela.navigate?.(destino);
          janela.postMessage({ tipo: 'notificacao-aberta' });
          return janela.focus();
        }
      }
      return self.clients.openWindow(destino);
    })
  );
});

/**
 * Alguns navegadores invalidam a inscrição sozinhos e emitem este evento.
 * Reinscrevemos e avisamos o backend para o aparelho não sumir do público.
 */
self.addEventListener('pushsubscriptionchange', (evento) => {
  evento.waitUntil(
    (async () => {
      try {
        const resposta = await fetch('/api/push/chave-publica');
        const { chave } = await resposta.json();
        const nova = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: chave,
        });
        await fetch('/api/push/inscrever', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ subscription: nova.toJSON() }),
        });
      } catch (erro) {
        console.error('[sw] falha ao renovar a inscrição', erro);
      }
    })()
  );
});
