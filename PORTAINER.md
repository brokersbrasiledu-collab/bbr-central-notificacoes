# Subir na VPS pelo Portainer

Guia visual para a **sua** VPS: Docker Swarm, Traefik na rede `AutoNet` e
Portainer. Se travar em algum passo, pare ali e me avise — não tente adivinhar.

**Nada aqui encosta no que já roda na sua VPS.** O app vira um serviço separado,
com volume separado. A stack do Traefik não é alterada em momento nenhum: ele
descobre o app sozinho. Se der errado, você remove a stack e a VPS fica
exatamente como estava.

**Tempo estimado:** 30 a 40 minutos, quase tudo esperando build.

---

## O que já está resolvido

Li o CMD do seu Traefik e configurei tudo com os seus valores:

| | Valor da sua VPS |
| --- | --- |
| Rede | `AutoNet` |
| Entrypoint HTTPS | `websecure` |
| Certificado | `letsencryptresolver` |
| Redirecionar http → https | já é global no seu Traefik |

Você não precisa preencher nada disso.

---

## Uma diferença importante do Swarm

Seu ambiente é **Docker Swarm**, e o Swarm **não compila imagem** — ele só sabe
baixar uma imagem já pronta. Por isso o caminho tem uma etapa a mais que o
normal:

```
Você envia os arquivos      O GitHub compila e         O Portainer baixa
   para o GitHub       →    publica a imagem      →    a imagem e sobe
   (arrastar e soltar)      (automático)                (colar e clicar)
```

A etapa do meio roda sozinha. Você só faz a primeira e a terceira, e nas
próximas atualizações só a primeira.

---

## Antes de começar

- Acesso ao seu Portainer
- Uma conta no GitHub (grátis)
- Um subdomínio livre, por exemplo `avisos.seudominio.com.br`

---

## Passo 1 — Apontar o domínio

Faça isso primeiro, porque é o que mais demora a propagar.

No painel onde fica seu domínio, crie um registro **A**:

- **Nome:** `avisos`
- **Aponta para:** o IP da sua VPS

A Let's Encrypt só emite o certificado depois que esse endereço responder.

---

## Passo 2 — Colocar o código no GitHub

Tudo pelo navegador.

1. Entre em **github.com** e faça login
2. Botão **+** no canto superior direito → **New repository**
3. Preencha:
   - **Repository name:** `bbr-central-notificacoes` (tudo minúsculo)
   - Marque **Private** — o código fica só seu
   - **Não** marque nenhuma caixinha de "Initialize"
4. **Create repository**
5. Na tela seguinte, clique em **uploading an existing file**
6. Abra a pasta `APP interno BBR` no Finder, selecione tudo (`Cmd + A`) e
   arraste para a área do GitHub
7. **Commit changes**

> **Confira antes de commitar:** na lista **não pode** aparecer `.env`,
> `node_modules` nem `dados`. O `.env` guarda a chave secreta do push.
>
> Ele fica oculto no Finder, então normalmente não vai junto. Para conferir,
> aperte `Cmd + Shift + .` na janela do Finder.

> **Importante:** a pasta `.github` **precisa** ir junto. É ela que constrói a
> imagem. Se o Finder não mostrar, é porque começa com ponto — use o mesmo
> `Cmd + Shift + .` para revelá-la.

---

## Passo 3 — Esperar a imagem ser construída

1. No seu repositório, abra a aba **Actions**
2. Vai ter uma execução chamada **Publicar imagem** rodando
3. Espere ficar com o ✓ verde (3 a 6 minutos na primeira vez)

Ao terminar, clique nela e leia a última linha do log. Vai aparecer o endereço
da imagem, algo como:

```
ghcr.io/seu-usuario/bbr-central-notificacoes:latest
```

**Anote esse endereço.** É o valor da variável `IMAGEM` no Passo 5.

> Se a aba Actions estiver vazia, a pasta `.github` não subiu. Volte ao Passo 2.

---

## Passo 4 — Dar ao Portainer acesso à imagem

Como o repositório é privado, a imagem também é. O Portainer precisa de uma
credencial para baixá-la.

### 4.1 — Criar o token no GitHub

1. github.com → sua foto → **Settings**
2. Role até o fim → **Developer settings**
3. **Personal access tokens** → **Tokens (classic)** → **Generate new token
   (classic)**
4. **Note:** `portainer`
5. **Expiration:** *No expiration*
6. Marque **apenas** a caixa **read:packages**
7. **Generate token** e **copie** — o GitHub só mostra uma vez

### 4.2 — Cadastrar no Portainer

1. Portainer → menu da esquerda → **Registries** → **+ Add registry**
2. Escolha **Custom registry**
3. Preencha:
   - **Name:** `ghcr`
   - **Registry URL:** `ghcr.io`
   - Ligue **Authentication**
   - **Username:** seu usuário do GitHub
   - **Password:** o token que você copiou
4. **Add registry**

---

## Passo 5 — Criar a stack

1. Portainer → **Stacks** → **+ Add stack**
2. **Name:** `bbr-push`
3. **Build method:** **Web editor**
4. Abra o arquivo `docker-compose.yml` da pasta do projeto, copie **tudo** e
   cole no editor
5. Role até **Environment variables** → **Advanced mode**
6. Cole o bloco de variáveis (veja abaixo como gerar)
7. **Deploy the stack**

### Gerando o bloco de variáveis

Na sua máquina, dentro da pasta do projeto:

```bash
npm run variaveis -- https://avisos.seudominio.com.br
```

Esse é o único comando do guia inteiro, e roda no **seu computador**, não na
VPS. Ele imprime o bloco pronto. Antes de colar, ajuste duas linhas:

- **`IMAGEM`** → o endereço que você anotou no Passo 3
- **`ADMIN_SENHA`** → a senha com que você vai entrar no app

---

## Passo 6 — Conferir

1. Portainer → **Services** (ou **Stacks** → `bbr-push`)
2. O serviço `bbr-push_bbr-push` precisa mostrar **1 / 1**

Depois abra `https://avisos.seudominio.com.br`. Se aparecer o cadeado e a tela
de login, acabou — o Traefik já pediu o certificado sozinho.

Se der erro de certificado, espere 2 minutos e recarregue. A emissão não é
instantânea.

---

## Passo 7 — Instalar no celular

Entre com o `ADMIN_EMAIL` e o `ADMIN_SENHA` que você definiu, vá em **Acessos**
e crie as contas do time. Depois, no celular de cada pessoa:

**Android (Chrome)** — o navegador oferece *Instalar app*. Aceite, abra pelo
ícone novo e toque em **Ativar agora**.

**iPhone (Safari)** — o push **só funciona** depois de salvar na tela inicial:

1. Toque em **Compartilhar** (o quadradinho com a seta para cima)
2. **Adicionar à Tela de Início**
3. Abra pelo ícone novo — não pelo Safari
4. Toque em **Ativar agora** e permita

Confirme em **Aparelho** → **Enviar teste**.

---

## Depois que estiver no ar

### Atualizar o app

1. Suba os arquivos novos no GitHub (mesma tela do Passo 2)
2. Espere o ✓ verde na aba **Actions**
3. Portainer → **Stacks** → `bbr-push` → **Update the stack**, com
   **Re-pull image** ligado

O volume não é tocado: contas, aparelhos e histórico continuam lá. Testei esse
ciclo — o app desliga antes de o novo subir, então nunca há dois processos
escrevendo no banco ao mesmo tempo.

### Fazer backup

O banco inteiro é um arquivo só, no volume `bbr-push-dados`.

Portainer → **Volumes** → `bbr-push-dados` → **Browse** → baixe `central.db`.

Vale fazer antes de cada atualização.

### Ver o que está acontecendo

Portainer → **Services** → `bbr-push_bbr-push` → **Logs**. Toda notificação
enviada e toda falha de entrega aparece ali.

---

## Se algo der errado

| O que você vê | O que é | O que fazer |
| --- | --- | --- |
| `network AutoNet not found` | A rede tem outro nome | Portainer → **Networks**, confira o nome exato |
| `no such image` ou *pull access denied* | O Portainer não conseguiu baixar | Refaça o Passo 4; confira se o token tem **read:packages** |
| Serviço em **0 / 1** | Falta alguma variável, ou a imagem não existe | Abra os **Logs** do serviço: a primeira linha diz qual |
| **404 page not found** no site | O Traefik não casou a rota | O `DOMINIO` precisa ser só o host: sem `https://` e sem barra no fim |
| Erro de certificado que não passa | O registro **A** não propagou | Confira o DNS; veja os **Logs** do Traefik |
| Aba **Actions** vazia no GitHub | A pasta `.github` não subiu | Volte ao Passo 2 e envie a pasta oculta |
| Login funciona no PC mas não no celular | Está entrando por `http` | Use sempre `https://` |
| iPhone sem o botão de ativar | App ainda não está na tela inicial | Adicione pelo Safari e abra pelo ícone |
| Notificação entra no histórico mas não chega | Permissão revogada ou inscrição expirada | Reative em **Aparelho** |

Em qualquer caso, um print dos **Logs** do serviço quase sempre me dá a causa
exata.
