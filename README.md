# Central de Notificações Push — Brokers Brasil

PWA instalável no celular do time que recebe **notificações push nativas** no Android e no
iPhone, alimentado por um backend Node com login multiacesso, webhook e histórico em linha
do tempo.

As notificações chegam de duas formas: **automática** (um webhook dispara quando algo
acontece no funil) e **manual** (o admin monta e envia a mensagem na hora). Todo mundo que
loga vê o mesmo histórico, da mais recente para a mais antiga.

Push pelo protocolo **Web Push com chaves VAPID** — direto para os servidores do Google e da
Apple. Não passa por Meta e não tem custo por mensagem.

---

## Índice

1. [Arquitetura](#arquitetura)
2. [Estrutura de arquivos](#estrutura-de-arquivos)
3. [Rodando na sua máquina](#rodando-na-sua-máquina)
4. [As cinco etapas de entrega](#as-cinco-etapas-de-entrega)
5. [Como usar os webhooks](#como-usar-os-webhooks)
6. [Níveis de acesso](#níveis-de-acesso)
7. [Referência da API](#referência-da-api)
8. [Deploy na VPS com HTTPS](#deploy-na-vps-com-https)
9. [Outras hospedagens](#outras-hospedagens)
10. [Manutenção e problemas comuns](#manutenção-e-problemas-comuns)

---

## Arquitetura

```
 Gatilho                Backend                 Serviço de push          Aparelho
─────────           ───────────────           ──────────────────      ─────────────
 CRM, n8n,   ──►    Node + Express     ──►     FCM (Google)     ──►    Notificação
 Make, Zapier       monta o payload           APNs (Apple)             nativa, com o
 ou o admin         e escolhe o alvo          assinado com VAPID       app aberto ou
 no painel                 │                                          fechado
                           ▼
                    SQLite (histórico)
```

Quatro camadas:

| Camada | O que faz | Onde está |
| --- | --- | --- |
| **PWA** | Instala na tela inicial, pede permissão, mostra o histórico, recebe o push | `public/` |
| **Backend** | Login, webhook, envio, histórico | `src/` |
| **Banco** | Contas, aparelhos, webhooks, notificações, preferências | `src/db/schema.sql` |
| **Push** | Ponte do Google e da Apple, via VAPID | biblioteca `web-push` |

---

## Estrutura de arquivos

```
.
├── src/
│   ├── server.js              Servidor HTTP: serve o PWA e a API
│   ├── config.js              Lê o .env e valida a configuração
│   ├── db/
│   │   ├── schema.sql         Estrutura do banco (idempotente)
│   │   └── index.js           Conexão, migração e admin inicial
│   ├── middlewares/
│   │   └── auth.js            Sessão em cookie httpOnly e níveis de acesso
│   ├── rotas/
│   │   ├── auth.js            Entrar, sair, trocar senha
│   │   ├── push.js            Chave VAPID, inscrição do aparelho, teste
│   │   ├── notificacoes.js    Linha do tempo e envio manual
│   │   ├── webhooks.js        Painel do admin + endereço público /hook/:slug
│   │   └── usuarios.js        Contas e níveis
│   └── servicos/
│       ├── push.js            Envio via VAPID e limpeza de inscrições mortas
│       └── modelo.js          Modelo de mensagem com {{variáveis}}
├── public/
│   ├── index.html             Casca do app
│   ├── app.js                 Telas, roteador, fluxo de permissão
│   ├── estilos.css            Identidade visual da Brokers
│   ├── manifest.json          Torna o app instalável
│   ├── sw.js                  Service worker: recebe o push e mostra a notificação
│   └── icones/                Ícones gerados (PNG)
├── scripts/
│   ├── gerar-vapid.js         Gera o par de chaves VAPID
│   ├── gerar-icones.js        Gera os ícones PNG da marca
│   ├── migrar.js              Aplica o schema
│   └── criar-admin.js         Cria/promove um administrador pelo terminal
├── infra/
│   ├── nginx.conf             Proxy reverso com HTTPS
│   └── bbr-push.service       Serviço systemd
├── .env.example
└── README.md
```

---

## Rodando na sua máquina

Requisitos: **Node.js 20 ou mais novo**.

```bash
npm install
cp .env.example .env

npm run vapid      # gera as chaves VAPID e grava no .env
npm run icones     # gera os ícones do PWA
```

Abra o `.env` e ajuste:

- `JWT_SECRET` — gere com `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `ADMIN_EMAIL` e `ADMIN_SENHA` — a conta de administrador criada na primeira execução

```bash
npm run dev        # http://localhost:3000
```

> **Sobre HTTPS no desenvolvimento:** `http://localhost` é tratado como contexto seguro pelos
> navegadores, então o service worker e o push funcionam normalmente na sua máquina. Para
> testar no celular você precisa de HTTPS de verdade — use um túnel
> (`cloudflared tunnel --url http://localhost:3000`) ou faça o deploy na VPS.

---

## As cinco etapas de entrega

Cada etapa é testável antes de seguir para a próxima.

### Etapa 1 — Base do push

```bash
npm run vapid
npm run dev
```

Entre com a conta de admin, vá em **Aparelho** e toque em **Ativar**. Depois use
**Enviar teste**. A notificação deve aparecer mesmo com a aba em segundo plano.

Teste rápido da API:

```bash
curl -s http://localhost:3000/api/saude
# {"ok":true,"push":true,"ambiente":"development"}
```

### Etapa 2 — PWA instalável

`manifest.json` + `sw.js` já estão prontos. No celular, o app deve oferecer instalação.
A tela inicial detecta o estado e reage:

| Situação | O que o app mostra |
| --- | --- |
| iPhone ainda no Safari | Instruções para **Adicionar à Tela de Início** |
| Permissão não pedida | Botão **Ativar agora** (o pedido sai no toque) |
| Permissão recusada | Aviso permanente com o caminho para liberar |
| Permissão concedida | A faixa some e o aparelho é inscrito |

### Etapa 3 — Login e histórico

Três níveis (admin, operador, membro) e a linha do tempo como tela principal de todos.
Crie contas em **Acessos**.

### Etapa 4 — Webhook e push manual

Em **Webhooks**, crie um gatilho, copie o endereço e a chave, e dispare. Em **Enviar**,
monte a mensagem manualmente e escolha o público.

### Etapa 5 — Identidade e deploy

O visual da Brokers já está aplicado. Suba na VPS seguindo
[Deploy na VPS com HTTPS](#deploy-na-vps-com-https).

---

## Como usar os webhooks

Cada webhook tem um **endereço único** e uma **chave secreta**, criados no painel.

### Disparando

A chave pode ir de três jeitos — use o que a sua ferramenta suportar:

```bash
# 1. Cabeçalho próprio (recomendado)
curl -X POST https://avisos.seudominio.com.br/hook/aK9xPq2mLdE1 \
  -H "X-Chave-Secreta: SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{"lead":{"nome":"Maria Souza","telefone":"11 98888-7777"},"origem":"Instagram"}'

# 2. Authorization: Bearer
curl -X POST https://avisos.seudominio.com.br/hook/aK9xPq2mLdE1 \
  -H "Authorization: Bearer SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{"nome":"Maria"}'

# 3. Na query (para ferramentas que só sabem chamar uma URL)
curl "https://avisos.seudominio.com.br/hook/aK9xPq2mLdE1?chave=SUA_CHAVE&nome=Maria"
```

O `GET` transforma os parâmetros da query nos dados da mensagem — resolve o caso da
planilha ou do script simples.

### Modelo com variáveis dinâmicas

Qualquer campo do JSON recebido vira variável:

| Modelo | JSON recebido | Resultado |
| --- | --- | --- |
| `Novo lead: {{nome}}` | `{"nome":"Maria"}` | Novo lead: Maria |
| `{{lead.nome}} ligou` | `{"lead":{"nome":"Ana"}}` | Ana ligou |
| `Item {{itens[0].valor}}` | `{"itens":[{"valor":"R$ 300"}]}` | Item R$ 300 |

Sempre disponíveis: `{{agora}}`, `{{data}}`, `{{hora}}` (fuso de São Paulo).
Variável que não existe no JSON vira texto vazio — não aparece `{{x}}` na tela.

### Integrações

- **n8n / Make / Zapier** — nó "HTTP Request", método POST, cabeçalho `X-Chave-Secreta`.
- **CRM** — cadastre o endereço como webhook de saída no evento desejado.
- **Script próprio** — qualquer `fetch`/`curl` serve.

### Segurança

- Chave comparada em tempo constante (não vaza pelo tempo de resposta).
- Endereço inexistente e chave errada devolvem a **mesma** resposta.
- Teto de 120 chamadas por minuto por IP.
- **Nova chave** no painel invalida a anterior na hora.

---

## Níveis de acesso

| | Administrador | Operador | Membro |
| --- | :---: | :---: | :---: |
| Ver o histórico | ✓ | ✓ | ✓ |
| Receber notificações | ✓ | ✓ | ✓ |
| Enviar push manual | ✓ | ✓ | — |
| Criar e configurar webhooks | ✓ | — | — |
| Gerenciar contas e níveis | ✓ | — | — |
| Apagar itens do histórico | ✓ | — | — |

O sistema recusa rebaixar, desativar ou excluir o **último administrador ativo**.

---

## Referência da API

Sessão em cookie `httpOnly`. Todas as respostas são JSON.

### Autenticação

| Método | Rota | Nível | O que faz |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | público | Entra (10 tentativas / 15 min por IP) |
| POST | `/api/auth/logout` | público | Sai |
| GET | `/api/auth/eu` | logado | Dados da sessão atual |
| POST | `/api/auth/senha` | logado | Troca a própria senha |

### Push

| Método | Rota | Nível | O que faz |
| --- | --- | --- | --- |
| GET | `/api/push/chave-publica` | público | Chave VAPID para o navegador |
| POST | `/api/push/inscrever` | logado | Registra o aparelho |
| POST | `/api/push/desinscrever` | logado | Remove o aparelho |
| GET | `/api/push/meus-aparelhos` | logado | Aparelhos da conta |
| GET | `/api/push/preferencias` | logado | Tipos que a pessoa recebe |
| POST | `/api/push/preferencias` | logado | Liga ou silencia um tipo |
| POST | `/api/push/teste` | logado | Notificação de teste (não entra no histórico) |

### Notificações

| Método | Rota | Nível | O que faz |
| --- | --- | --- | --- |
| GET | `/api/notificacoes` | membro | Linha do tempo (`?limite=&antes=&tipo=`) |
| GET | `/api/notificacoes/resumo` | membro | Contagem total e do dia |
| GET | `/api/notificacoes/alcance` | operador | Quantos aparelhos um público atinge |
| POST | `/api/notificacoes/enviar` | operador | Envio manual |
| DELETE | `/api/notificacoes/:id` | admin | Apaga do histórico |

### Webhooks e usuários

| Método | Rota | Nível |
| --- | --- | --- |
| GET / POST | `/api/webhooks` | admin |
| PATCH / DELETE | `/api/webhooks/:id` | admin |
| POST | `/api/webhooks/:id/rotacionar-chave` | admin |
| POST | `/api/webhooks/previa` | admin |
| GET / POST | `/api/usuarios` | admin |
| PATCH / DELETE | `/api/usuarios/:id` | admin |
| POST | `/api/usuarios/:id/senha` | admin |
| POST / GET | `/hook/:slug` | chave secreta |

---

## Deploy na VPS com HTTPS

> **Regra única: sem HTTPS o push não funciona.** Navegadores só registram service worker
> em contexto seguro.

> ### Já usa Portainer com Traefik? Vá por [PORTAINER.md](PORTAINER.md)
>
> Se a VPS já roda outros serviços, o caminho por Docker é mais seguro e quase todo por
> painel: o app vira um serviço isolado, com volume próprio, sem tocar em nada que já está
> no ar. Já vêm prontos o [Dockerfile](Dockerfile), o
> [docker-compose.yml](docker-compose.yml) para Docker Swarm com labels de Traefik, e o
> [fluxo do GitHub Actions](.github/workflows/publicar-imagem.yml) que publica a imagem —
> necessário porque o Swarm não compila imagem, só baixa.
>
> A instalação manual abaixo é para uma VPS limpa, dedicada a este app.

Testado em Ubuntu 22.04/24.04. Substitua `avisos.seudominio.com.br` pelo seu domínio.

### 1. Aponte o domínio

No painel do seu registrador, crie um registro **A** apontando para o IP da VPS.
Confirme com `dig +short avisos.seudominio.com.br` antes de seguir.

### 2. Prepare o servidor

```bash
ssh root@SEU_IP

apt update && apt upgrade -y
apt install -y curl git nginx ufw

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Firewall
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

### 3. Crie o usuário da aplicação

Rodar como root é risco desnecessário.

```bash
adduser --system --group --home /opt/bbr-push bbrpush
mkdir -p /opt/bbr-push /var/lib/bbr-push
chown -R bbrpush:bbrpush /opt/bbr-push /var/lib/bbr-push
```

### 4. Envie o código

```bash
# Da sua máquina:
rsync -av --exclude node_modules --exclude .env --exclude dados \
  ./ root@SEU_IP:/opt/bbr-push/

# Na VPS:
cd /opt/bbr-push
npm ci --omit=dev
chown -R bbrpush:bbrpush /opt/bbr-push
```

### 5. Configure o `.env`

```bash
cd /opt/bbr-push
cp .env.example .env
npm run vapid          # gera e grava as chaves VAPID
nano .env
```

Deixe assim (ajustando domínio, segredo e senha):

```ini
PORT=3000
NODE_ENV=production
APP_URL=https://avisos.seudominio.com.br
DB_PATH=/var/lib/bbr-push/central.db
JWT_SECRET=<48 bytes aleatórios em hex>
TRUST_PROXY=1
VAPID_SUBJECT=mailto:contato@seudominio.com.br
ADMIN_EMAIL=voce@seudominio.com.br
ADMIN_SENHA=<senha forte>
```

Gere o segredo com:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Proteja o arquivo — ele guarda a chave privada VAPID e o segredo de sessão:

```bash
chmod 600 .env && chown bbrpush:bbrpush .env
npm run icones
npm run migrar         # cria o banco e o administrador inicial
```

### 6. Suba o serviço com systemd

```bash
cp infra/bbr-push.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bbr-push
systemctl status bbr-push
```

### 7. Nginx e certificado

```bash
cp infra/nginx.conf /etc/nginx/sites-available/bbr-push
sed -i 's/avisos.seudominio.com.br/SEU_DOMINIO_REAL/g' /etc/nginx/sites-available/bbr-push
ln -sf /etc/nginx/sites-available/bbr-push /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Certificado gratuito da Let's Encrypt (o Certbot ajusta o Nginx sozinho):

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d avisos.seudominio.com.br --redirect --agree-tos -m voce@seudominio.com.br
```

A renovação automática já vem configurada. Confira com `certbot renew --dry-run`.

### 8. Confirme

```bash
curl -s https://avisos.seudominio.com.br/api/saude
# {"ok":true,"push":true,"ambiente":"production"}
```

Abra o endereço no celular, entre com a conta de admin e ative as notificações.

### 9. Instalação no celular

**Android (Chrome)** — o navegador oferece "Instalar app". Aceite, abra pelo ícone e toque
em **Ativar agora**.

**iPhone (Safari, iOS 16.4+)** — o push **só funciona depois** de salvar na tela inicial:

1. Toque em **Compartilhar** na barra do Safari
2. **Adicionar à Tela de Início**
3. Abra pelo novo ícone
4. Toque em **Ativar agora** e permita

No iOS 26 todo site salvo na tela inicial já abre como app.

### Atualizações depois do primeiro deploy

```bash
rsync -av --exclude node_modules --exclude .env --exclude dados ./ root@SEU_IP:/opt/bbr-push/
ssh root@SEU_IP 'cd /opt/bbr-push && npm ci --omit=dev && chown -R bbrpush:bbrpush . && systemctl restart bbr-push'
```

O `sw.js` é servido com `Cache-Control: no-cache`, então o service worker novo entra no ar
sem o usuário precisar reinstalar o app.

---

## Outras hospedagens

**Hostinger** — funciona para o app e o domínio. Para o backend, o plano precisa rodar Node
e dar acesso ao servidor (VPS ou Cloud). Em hospedagem compartilhada só de PHP, não roda.

**Vercel** — ótima para o PWA e para as rotas de API, mas o sistema de arquivos é efêmero:
o SQLite não sobrevive. Troque por Postgres gerenciado (Neon, Supabase, Railway) e adapte
`src/db/index.js`. As tabelas em `schema.sql` são portáveis — troque
`INTEGER PRIMARY KEY AUTOINCREMENT` por `SERIAL PRIMARY KEY` e `datetime('now')` por `now()`.

**Recomendação:** VPS. Backend, banco e app no mesmo lugar, HTTPS gratuito e controle total.

---

## Manutenção e problemas comuns

### Backup do banco

Um arquivo só. Faça a cópia com o SQLite (seguro com o serviço rodando):

```bash
sqlite3 /var/lib/bbr-push/central.db ".backup '/root/backup-$(date +%F).db'"
```

Diário via cron:

```bash
echo '0 3 * * * sqlite3 /var/lib/bbr-push/central.db ".backup /root/backups/central-$(date +\%F).db"' | crontab -
```

### Logs

```bash
journalctl -u bbr-push -f          # ao vivo
journalctl -u bbr-push --since today
```

### Perdi o acesso de administrador

```bash
cd /opt/bbr-push
sudo -u bbrpush npm run criar-admin -- "Seu Nome" voce@dominio.com senhaforte123
```

### Problemas comuns

| Sintoma | Causa provável | Solução |
| --- | --- | --- |
| Não aparece "Instalar app" | Sem HTTPS, ou manifest/service worker não carregou | Confira o certificado e abra `/manifest.json` e `/sw.js` no navegador |
| iPhone não mostra o botão de ativar | App ainda não está na tela inicial | Adicione pelo Safari e abra pelo ícone |
| "Servidor sem chaves VAPID" | `.env` sem as chaves | `npm run vapid` e reinicie o serviço |
| Notificação não chega, mas entra no histórico | Inscrição expirada ou permissão revogada | Reative em **Aparelho**; inscrições mortas são removidas sozinhas |
| Push parou para todo mundo de uma vez | Chaves VAPID trocadas | Restaure as chaves originais; se não houver cópia, todos precisam reativar |
| `403` ao trocar o próprio nível | Trava do último administrador | Promova outra conta antes |
| Login sempre falha em produção | `NODE_ENV=production` sem HTTPS de verdade | O cookie é `Secure`; o site precisa estar em HTTPS |

### Trocar as chaves VAPID

**Só faça se for inevitável.** Chaves novas invalidam **todas** as inscrições — cada pessoa
precisa reativar a notificação no celular. Guarde uma cópia segura das chaves atuais.

---

## Decisões técnicas

- **SQLite** — um arquivo, zero administração, sobra folga para o volume de um time interno.
  A troca por Postgres fica isolada em `src/db/index.js`.
- **Sessão em cookie `httpOnly`** — o JavaScript da página não lê o token, o que fecha a
  porta para roubo de sessão por XSS.
- **bcrypt com custo 12** — senha nunca é guardada em texto puro.
- **Histórico gravado antes do envio** — a notificação existe na linha do tempo mesmo que a
  entrega falhe. O histórico é a fonte de verdade.
- **Limpeza automática de inscrições mortas** — respostas `404` e `410` do serviço de push
  removem o aparelho do banco, evitando lixo acumulado.
- **Sem dependência de front-end** — HTML, CSS e JS puros. Menos peso no celular e nada para
  atualizar por vulnerabilidade de framework.
