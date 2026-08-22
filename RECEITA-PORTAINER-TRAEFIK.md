# Receita: GitHub → GHCR → Portainer → Traefik

Documento portátil. Foi extraído de um projeto que já roda em produção nesta
infraestrutura e serve para **qualquer projeto novo** subir do mesmo jeito.

**Para o Claude Code do outro projeto:** este arquivo é a especificação completa.
Adapte os nomes (serviço, volume, router, domínio, porta) ao projeto atual, mas
**não invente valores de infraestrutura** — os da seção "Fatos da VPS" são fixos
e já validados. Onde houver um "porquê", ele existe porque a alternativa já
quebrou em produção uma vez.

---

## 1. Como o ciclo funciona

```
    você edita o código
            │
            ▼
    git push  →  branch main no GitHub
            │
            ▼
    GitHub Actions constrói a imagem Docker
            │
            ▼
    publica em ghcr.io/USUARIO/REPO:latest   (~1 min, automático)
            │
            ▼
    Portainer → Stacks → "Pull and redeploy"   ← único passo manual
            │
            ▼
    Docker Swarm baixa a imagem nova e troca o container
            │
            ▼
    Traefik já conhece a rota: HTTPS no ar, certificado automático
```

**A peça central:** o Docker Swarm **não compila imagem**. Ele só sabe baixar uma
pronta de um registro. Por isso o GitHub Actions existe — ele é a fábrica. Sem
ele, você teria que ter Docker instalado e compilar na sua máquina ou na VPS.

**Duas conexões distintas com o GitHub, não confunda:**

| Conexão | O que ela busca | Onde se configura |
| --- | --- | --- |
| GitHub → GHCR | constrói e guarda a **imagem** (o app compilado) | `.github/workflows/` |
| Portainer → GitHub | lê o **docker-compose.yml** do repositório | Stack em modo *Repository* |

A segunda é opcional (dá para colar o compose no *Web editor*), mas usá-la
significa que uma mudança no compose entra junto com o `Pull and redeploy`, sem
copiar e colar nada.

---

## 2. Fatos da VPS (fixos, não mudar)

Esses valores já estão certos e são compartilhados por todos os projetos:

| Item | Valor | Observação |
| --- | --- | --- |
| Orquestrador | **Docker Swarm** | não é `docker compose` puro — isso muda a sintaxe |
| Rede do Traefik | **`AutoNet`** | externa, já existe; confira em Portainer → Networks |
| Entrypoint HTTPS | **`websecure`** | o redirecionamento http→https já é global |
| Resolvedor de certificado | **`letsencryptresolver`** | emite sozinho, leva ~2 min |
| Registro de imagens | **`ghcr.io`** | público por padrão, o Portainer baixa sem senha |
| Painel | **Portainer** | é ele que dá o `docker stack deploy` |

**A stack do Traefik nunca é alterada.** Ele descobre serviços novos sozinho,
lendo as *labels* de cada serviço. Um projeto novo = uma stack nova, isolada.
Se der errado, remove a stack e a VPS volta exatamente ao estado anterior.

---

## 3. Os quatro arquivos

O projeto precisa de exatamente quatro arquivos novos. Nada mais.

### 3.1 `Dockerfile`

```dockerfile
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Manifestos primeiro: o Docker reaproveita a camada das dependências
# quando só o código muda. Deploys ficam muito mais rápidos.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Carimbo da build. O Actions injeta aqui o commit que gerou a imagem,
# e o app devolve o valor em /api/saude. É assim que se confirma pelo
# navegador qual versão está de fato rodando na VPS.
ARG VERSAO=local
ENV VERSAO=$VERSAO

# Pasta de dados com o dono certo ANTES de trocar de usuário.
# O volume nomeado herda estas permissões na primeira montagem —
# sem isso o container sobe mas não consegue gravar.
RUN mkdir -p /dados && chown -R node:node /dados /app

USER node
EXPOSE 3000

# O Portainer mostra este estado como "healthy" na lista de containers.
# A folga de 45s na partida evita que uma VPS ocupada marque o serviço
# como doente antes de ele terminar de subir — o Swarm reiniciaria em
# looping e você veria "0 / 1" sem entender por quê.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
```

Decisões e porquês:

- **`node:22-slim` (Debian), não Alpine.** Pacotes com binário nativo
  (`better-sqlite3`, `sharp`, `bcrypt`) têm build pronto para Debian. No Alpine
  (musl) o npm cai para compilar do zero — o build passa de segundos para
  muitos minutos, e às vezes falha por falta de toolchain.
- **`USER node`.** Nunca rodar como root.
- **`ARG VERSAO`.** É o que torna o deploy verificável. Sem isso, você fica
  adivinhando se a correção subiu.

### 3.2 `.dockerignore`

```
.env
.env.*
!.env.example
dados/
node_modules/
*.db
*.db-journal
*.db-wal
*.db-shm
.git/
.github/
.gitignore
.DS_Store
*.md
```

O `.env` fica de fora **de propósito**: os segredos são preenchidos no painel do
Portainer, não assados dentro da imagem. Imagem pública com segredo dentro é
vazamento.

### 3.3 `.github/workflows/publicar-imagem.yml`

```yaml
name: Publicar imagem

on:
  push:
    branches: [main, master]
    # Mudança só de documentação não precisa reconstruir a imagem.
    paths-ignore:
      - '**.md'
  workflow_dispatch:   # habilita o botão "Run workflow" na aba Actions

jobs:
  publicar:
    runs-on: ubuntu-latest

    permissions:
      contents: read
      packages: write        # necessário para publicar no ghcr.io

    steps:
      - name: Baixar o código
        uses: actions/checkout@v4

      # O ghcr.io só aceita nome de imagem em minúsculas, e o nome de
      # usuário/organização do GitHub pode ter maiúsculas. O ",," do bash
      # resolve isso. Sem essa linha o push falha com erro obscuro.
      - name: Montar o nome da imagem
        id: nome
        run: echo "imagem=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_OUTPUT"

      - name: Preparar o Buildx
        uses: docker/setup-buildx-action@v3

      - name: Entrar no registro
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}   # o GitHub gera sozinho

      - name: Construir e publicar
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          platforms: linux/amd64      # a VPS é x86; multi-arch só faria o build demorar
          build-args: |
            VERSAO=${{ github.sha }}
          tags: |
            ${{ steps.nome.outputs.imagem }}:latest
            ${{ steps.nome.outputs.imagem }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max   # o segundo build leva segundos

      - name: Endereço da imagem
        run: |
          echo "::notice title=Imagem publicada::${{ steps.nome.outputs.imagem }}:latest"
```

Pontos que economizam tempo:

- **`secrets.GITHUB_TOKEN` já existe.** Não precisa criar Personal Access Token
  nem configurar segredo nenhum no repositório. Só a permissão `packages: write`.
- **Duas tags sempre.** `:latest` é o que o Portainer usa; `:SHA` é o histórico —
  permite voltar para uma versão específica trocando a variável `IMAGEM`.
- **`platforms: linux/amd64`.** Se você buildar em Mac Apple Silicon sem isso,
  sai uma imagem `arm64` que a VPS não roda (`exec format error`).

### 3.4 `docker-compose.yml`

```yaml
version: '3.8'

services:
  APP:                                   # ← troque pelo nome do projeto
    # O Swarm não compila: a imagem vem pronta do GHCR.
    #
    # A sintaxe ":?" torna a variável obrigatória — se faltar, o deploy
    # falha NA HORA com essa mensagem. Sem isso, uma variável esquecida
    # vira string vazia e o erro só aparece depois, disfarçado.
    image: ${IMAGEM:?defina IMAGEM nas variaveis da stack}

    environment:
      NODE_ENV: production
      PORT: 3000
      TRUST_PROXY: 1                     # o Traefik entrega o IP real do visitante
      DB_PATH: /dados/base.db

      APP_URL: ${APP_URL:?defina APP_URL nas variaveis da stack}
      JWT_SECRET: ${JWT_SECRET:?defina JWT_SECRET nas variaveis da stack}
      # ... demais segredos do projeto, sempre com :? se forem obrigatórios
      # ... use ${VAR:-padrao} quando houver um default aceitável

    volumes:
      - APP-dados:/dados                 # sobrevive a atualizações da stack

    networks:
      - AutoNet

    deploy:
      mode: replicated
      replicas: 1                        # ver nota sobre estado, abaixo

      placement:
        constraints:
          # Prende ao nó gerente. O volume é local ao nó: o serviço
          # precisa voltar sempre no mesmo lugar para reencontrar os dados.
          - node.role == manager

      update_config:
        order: stop-first                # ver nota sobre estado, abaixo
        failure_action: rollback
        delay: 5s

      restart_policy:
        condition: any
        delay: 10s

      resources:
        limits:   { cpus: '1', memory: 512M }
        reservations: { memory: 128M }

      # ── Instruções para o Traefik ────────────────────────────────
      # ⚠️ Em Swarm as labels ficam AQUI, dentro de "deploy".
      # No nível do serviço o Traefik não enxerga e o site dá 404.
      labels:
        - traefik.enable=true
        - traefik.docker.network=AutoNet

        # Só o host: sem "https://" e sem barra no fim.
        - traefik.http.routers.APP.rule=Host(`${DOMINIO:?defina DOMINIO nas variaveis da stack}`)
        - traefik.http.routers.APP.entrypoints=websecure
        - traefik.http.routers.APP.tls=true
        - traefik.http.routers.APP.tls.certresolver=letsencryptresolver

        # Porta interna do container. Em Swarm este rótulo é OBRIGATÓRIO:
        # o Traefik não descobre a porta sozinho.
        - traefik.http.services.APP.loadbalancer.server.port=3000

        # Manda o navegador só voltar por HTTPS.
        - traefik.http.middlewares.APP-hsts.headers.stsSeconds=31536000
        - traefik.http.routers.APP.middlewares=APP-hsts

    logging:
      driver: json-file
      options:
        max-size: '10m'                  # evita o log encher o disco da VPS
        max-file: '3'

volumes:
  APP-dados:
    name: APP-dados                      # nome fixo: facilita achar em Portainer → Volumes

networks:
  AutoNet:
    external: true
    name: AutoNet
```

Troque **todas** as ocorrências de `APP` por um identificador curto e único do
projeto (sem hífen nos nomes de router/service do Traefik é mais seguro). O nome
do router precisa ser único **na VPS inteira**, não só na stack — dois projetos
com `traefik.http.routers.app` colidem.

#### Nota sobre estado — leia antes de copiar

`replicas: 1` + `order: stop-first` + `node.role == manager` formam um conjunto,
e ele existe por causa de **banco em arquivo (SQLite)**:

- duas réplicas escreveriam no mesmo arquivo e o corromperiam;
- `stop-first` derruba o container antigo **antes** de subir o novo, então nunca
  há dois processos no mesmo arquivo;
- a constraint prende ao nó onde o volume está.

**Se o projeto novo for stateless** (banco externo — Postgres, Supabase, API), a
receita muda:

| | Com SQLite / arquivo local | Stateless |
| --- | --- | --- |
| `replicas` | `1`, obrigatoriamente | pode escalar |
| `order` | `stop-first` | `start-first` (deploy sem downtime) |
| `placement` | `node.role == manager` | pode omitir |
| `volumes` | obrigatório | pode omitir |

---

## 4. O endpoint de saúde

Não é opcional. É o que fecha o ciclo — sem ele você não sabe se o deploy subiu.

```js
app.get('/api/saude', (_req, res) => {
  res.json({
    ok: true,
    versao: process.env.VERSAO || 'local',
    ambiente: process.env.NODE_ENV,
  });
});
```

Depois do `Pull and redeploy`, abra `https://SEU-DOMINIO/api/saude` e compare o
campo `versao` com o commit mais recente no GitHub. Bateu → a VPS está com a
versão nova. **Confira isso antes de reportar que uma correção não funcionou.**
Na maioria das vezes é o deploy que ainda não subiu, não o código.

O mesmo endpoint serve de `HEALTHCHECK` no Dockerfile — um trabalho, dois usos.

---

## 5. Cache do navegador (se o projeto tiver front-end)

Problema real que já custou horas: o deploy sobe, o `/api/saude` mostra o commit
novo, e a tela continua velha. É o navegador servindo CSS/JS do cache.

Solução aplicada: **versionar as URLs dos estáticos com o commit**. No HTML,
escreva `__VERSAO__` e substitua na hora de servir:

```js
const html = fs.readFileSync(arquivo, 'utf8').replaceAll('__VERSAO__', config.versao);
// <script src="/app.js?v=__VERSAO__">  →  <script src="/app.js?v=a1b2c3d">
```

Vale para `app.js`, `estilos.css`, ícones e o `manifest.json`. Em PWA, versione
também a constante `VERSAO` do service worker — é o que dispara a troca de cache
dele.

---

## 6. Passo a passo no Portainer

**1. DNS primeiro** (é o que mais demora a propagar). No painel do domínio, um
registro **A**: nome `SUBDOMINIO` → IP da VPS. A Let's Encrypt só emite o
certificado depois que esse endereço responder.

**2. Confirmar que a imagem existe.** Aba **Actions** do repositório: o workflow
"Publicar imagem" tem que estar verde. Ele imprime o endereço da imagem no fim.

**3. Deixar a imagem pública** (uma vez por repositório). GitHub → seu perfil →
**Packages** → o pacote → **Package settings** → **Change visibility** →
*Public*. Sem isso, o Portainer não consegue baixar e o serviço fica em `0 / 1`.

**4. Criar a stack.** Portainer → **Stacks** → **+ Add stack**:

| Campo | Valor |
| --- | --- |
| Name | nome curto do projeto |
| Build method | **Repository** |
| Repository URL | `https://github.com/USUARIO/REPO` |
| Repository reference | `refs/heads/main` |
| Compose path | `docker-compose.yml` |
| Authentication | **desligado** (se o repo for público) |

**5. Environment variables → Advanced mode** e cole o bloco:

```
IMAGEM=ghcr.io/usuario/repo:latest
APP_URL=https://sub.dominio.com.br
DOMINIO=sub.dominio.com.br
JWT_SECRET=<48 bytes aleatórios em hex>
...
```

⚠️ `APP_URL` leva `https://`. `DOMINIO` **não** — só o host, sem barra no fim.
É a confusão que mais gera 404.

Gerar o segredo: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

**6. Deploy the stack.** Depois, **Services**: o serviço precisa mostrar `1 / 1`.
Então abra `https://SEU-DOMINIO`. Se der erro de certificado, espere 2 minutos e
recarregue — a emissão não é instantânea.

### Atualizar depois

**Portainer → Stacks → sua stack → Pull and redeploy.** Só isso.

O volume não é tocado: dados continuam lá. E **não precisa do "Re-pull image"**
(recurso pago) — em Swarm, o `docker stack deploy` consulta o registro e fixa a
imagem pelo digest a cada deploy; digest novo, tarefa nova.

> Se você editar a stack **direto no editor do Portainer** e ela estiver em modo
> *Repository*, o próximo `Pull and redeploy` busca o arquivo do GitHub de novo e
> **descarta a sua edição**. Correção que precisa sobreviver vai no repositório
> ou nas variáveis da stack — nunca só no editor.

---

## 7. Erros já vividos e a causa real

| Sintoma | Causa | Correção |
| --- | --- | --- |
| **404 page not found** no site | labels do Traefik no nível errado do YAML | têm que estar dentro de `deploy.labels` |
| **404** com certificado errado | `DOMINIO` com `https://` ou barra no fim | só o host |
| Serviço em **0 / 1** | variável faltando, ou imagem privada | Logs do serviço: a primeira linha diz |
| `network AutoNet not found` | nome da rede diferente | Portainer → Networks, confira o nome exato |
| Serviço reinicia em looping | healthcheck falhou na partida | aumente `--start-period` |
| Deploy "não pegou" | é o cache do navegador | versione as URLs dos estáticos |
| `exec format error` | imagem buildada em arm64 | `platforms: linux/amd64` |
| Push para o GHCR falha | maiúscula no nome do repositório | `${GITHUB_REPOSITORY,,}` |
| Container não grava em disco | volume montado sem dono certo | `chown` no Dockerfile **antes** do `USER` |
| Variável vazia com erro estranho | falta de validação | use `${VAR:?mensagem}` em tudo que é obrigatório |

---

## 8. Checklist para um projeto novo

- [ ] `Dockerfile` com `ARG VERSAO`, `HEALTHCHECK` e `USER` não-root
- [ ] `.dockerignore` excluindo `.env`, `node_modules`, `.git`
- [ ] `.github/workflows/publicar-imagem.yml` com `packages: write`
- [ ] `docker-compose.yml` com labels **dentro de `deploy`** e nomes de router únicos
- [ ] Endpoint `/api/saude` devolvendo `VERSAO`
- [ ] Estáticos versionados por `?v=<commit>` (se houver front-end)
- [ ] Registro **A** do subdomínio apontando para a VPS
- [ ] Pacote do GHCR marcado como **público**
- [ ] Stack criada em modo *Repository*, variáveis em *Advanced mode*
- [ ] `Services` mostrando `1 / 1` e `/api/saude` com o commit certo

---

## 9. Se o repositório for privado

A imagem também vira privada, e aí o Portainer precisa de credencial:

**Registries** → **Add registry** → *Custom registry* → URL `ghcr.io`, usuário =
seu login do GitHub, senha = um **Personal Access Token (classic)** com o escopo
`read:packages`. Depois, na stack em modo *Repository*, ligue **Authentication**
e informe o mesmo token.
