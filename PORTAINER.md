# Subir na VPS pelo Portainer

Guia visual, sem comando no servidor. Se em algum momento você travar, pare
naquele passo e me avise — não tente adivinhar.

**Nada aqui encosta no que já roda na sua VPS.** O app vira um container
separado, com volume separado e porta separada. Se der errado, você apaga a
stack e a VPS fica exatamente como estava.

**Tempo estimado:** 20 a 30 minutos.

---

## Antes de começar

Você vai precisar de:

- Acesso ao seu Portainer
- Uma conta no GitHub (grátis)
- Um subdomínio livre, por exemplo `avisos.seudominio.com.br`

---

## Passo 1 — Descobrir o que já publica seus sites

Este é o único ponto que muda o resto do guia, então vale um minuto.

1. Abra o Portainer
2. Menu da esquerda → **Containers**
3. Olhe a lista procurando algum destes nomes:

| Se você vê… | Você usa | O que fazer no Passo 6 |
| --- | --- | --- |
| `nginx-proxy-manager`, `npm`, `nginxproxymanager` | Nginx Proxy Manager | Caminho **A** |
| `traefik` | Traefik | Caminho **B** |
| `coolify`, `easypanel`, `caprover` | Painel próprio | Caminho **C** |
| nada parecido | Ainda não tem proxy | Caminho **C** |

Anote o que apareceu. Se ficar em dúvida, tire um print da lista e me mande.

---

## Passo 2 — Colocar o código no GitHub

O Portainer busca o código de um endereço do GitHub. É tudo pelo navegador.

1. Entre em **github.com** e faça login
2. Botão verde **New** (ou o **+** no canto superior direito → *New repository*)
3. Preencha:
   - **Repository name:** `bbr-central-notificacoes`
   - Marque **Private** — o código fica só seu
   - **Não** marque nenhuma das caixinhas de "Initialize"
4. **Create repository**
5. Na tela seguinte, clique em **uploading an existing file**
6. Abra a pasta `APP interno BBR` no Finder, selecione **tudo** (`Cmd + A`) e
   arraste para a área do GitHub
7. Espere terminar e clique em **Commit changes**

> **Confira antes de commitar:** na lista de arquivos enviados **não pode**
> aparecer `.env`, `node_modules` nem `dados`. Se aparecer, remova do envio.
> O `.env` guarda a chave secreta do push.
>
> Se o Finder não mostrar o arquivo `.env`, ótimo — ele está oculto e não vai
> junto. Para conferir, aperte `Cmd + Shift + .` na janela do Finder.

Ao final, copie o endereço do repositório da barra do navegador. Vai ser algo
como `https://github.com/seu-usuario/bbr-central-notificacoes`.

---

## Passo 3 — Gerar as variáveis

Na sua máquina, dentro da pasta do projeto, rode:

```bash
npm run variaveis -- https://avisos.seudominio.com.br
```

Ele imprime um bloco pronto. **Copie esse bloco inteiro** — você vai colar no
Portainer no passo 4. Antes, troque o `ADMIN_SENHA` pela senha que você quer
usar para entrar no app.

Esse é o único comando do guia todo, e roda no seu computador, não na VPS.

---

## Passo 4 — Criar a stack no Portainer

1. Portainer → menu da esquerda → **Stacks**
2. Botão **+ Add stack**
3. **Name:** `bbr-push`
4. Em **Build method**, escolha **Repository**
5. Preencha:
   - **Repository URL:** o endereço do GitHub do passo 2
   - **Repository reference:** deixe como está (`refs/heads/main`)
   - **Compose path:** `docker-compose.yml`
6. Como o repositório é privado, ligue **Authentication** e informe seu usuário
   do GitHub e um *token*:
   - Abra github.com → foto do perfil → **Settings** → role até o fim →
     **Developer settings** → **Personal access tokens** → **Tokens (classic)**
   - **Generate new token (classic)**, marque o escopo **repo**, gere e copie
   - Cole no campo de senha do Portainer
7. Role até **Environment variables** e clique em **Advanced mode**
8. **Cole o bloco** que você copiou no passo 3
9. Botão **Deploy the stack**

A primeira vez demora de 2 a 5 minutos: o Portainer baixa o Node e instala as
dependências. Nas próximas, cai para segundos.

---

## Passo 5 — Conferir se subiu

1. Portainer → **Containers**
2. Procure `bbr-push`. O estado precisa estar **running** e, depois de uns 30
   segundos, **healthy**

Se aparecer *unhealthy* ou *exited*, clique no nome do container e depois em
**Logs**. A primeira linha costuma dizer exatamente o que falta. Me mande o
print que eu traduzo.

---

## Passo 6 — Publicar com HTTPS

Sem HTTPS o push **não funciona** — é regra do navegador, não do nosso código.

Antes de tudo: no painel onde fica seu domínio, crie um registro **A** com o
nome `avisos` apontando para o IP da sua VPS. Leva de minutos a algumas horas
para propagar.

### Caminho A — Nginx Proxy Manager

1. Abra o Nginx Proxy Manager
2. **Hosts** → **Proxy Hosts** → **Add Proxy Host**
3. Aba **Details**:
   - **Domain Names:** `avisos.seudominio.com.br`
   - **Scheme:** `http`
   - **Forward Hostname / IP:** `bbr-push`
   - **Forward Port:** `3000`
   - Ligue **Block Common Exploits** e **Websockets Support**
4. Aba **SSL**:
   - **SSL Certificate:** *Request a new SSL Certificate*
   - Ligue **Force SSL** e **HTTP/2 Support**
   - Aceite os termos da Let's Encrypt
5. **Save**

> Se der erro de "host not found" no passo 3, o proxy e o app estão em redes
> Docker diferentes. Duas saídas: usar `IP-DA-SUA-VPS` e porta `3000` no lugar
> de `bbr-push`, ou descomentar o bloco `networks` no `docker-compose.yml`. Me
> avise que eu ajusto.

### Caminho B — Traefik

Me mande um print do `docker-compose.yml` do seu Traefik. Eu escrevo as
*labels* certas e você só troca o arquivo — Traefik é configurado por rótulos,
e eles precisam bater com a sua instalação.

### Caminho C — Ainda não tem proxy

Aqui eu recomendo instalar o **Nginx Proxy Manager**, que também é uma stack do
Portainer e resolve o HTTPS de todos os seus sites por painel, com botão de
renovar certificado. Me confirme que eu te passo a stack pronta dele.

---

## Passo 7 — Primeiro acesso e instalação no celular

1. Abra `https://avisos.seudominio.com.br` no computador
2. Entre com o `ADMIN_EMAIL` e o `ADMIN_SENHA` que você definiu
3. Vá em **Acessos** e crie as contas do time

No celular de cada pessoa:

**Android (Chrome)** — o navegador oferece *Instalar app*. Aceite, abra pelo
ícone novo e toque em **Ativar agora**.

**iPhone (Safari)** — o push **só funciona** depois de salvar na tela inicial:

1. Toque em **Compartilhar** (o quadradinho com a seta para cima)
2. **Adicionar à Tela de Início**
3. Abra pelo ícone novo — não pelo Safari
4. Toque em **Ativar agora** e permita

Depois, em **Aparelho** → **Enviar teste**, para confirmar que chega.

---

## Depois que estiver no ar

### Atualizar o app

1. Suba os arquivos novos no GitHub (mesma tela do passo 2)
2. Portainer → **Stacks** → `bbr-push` → **Pull and redeploy**

Os dados ficam no volume e **não** são apagados por atualização.

### Fazer backup

O banco inteiro é um arquivo só, dentro do volume `bbr-push-dados`.

1. Portainer → **Volumes** → `bbr-push-dados` → **Browse**
2. Baixe o arquivo `central.db`

Vale fazer isso de vez em quando, principalmente antes de uma atualização.

### Ver o que está acontecendo

Portainer → **Containers** → `bbr-push` → **Logs**. Toda notificação enviada e
toda falha de entrega aparece ali.

---

## Se algo der errado

| O que você vê | O que é | O que fazer |
| --- | --- | --- |
| Container em *exited* logo após o deploy | Falta alguma variável | Abra os **Logs**: a primeira linha diz qual |
| `port is already allocated` | A porta 3000 já é de outro serviço seu | No `docker-compose.yml`, troque `'3000:3000'` por `'3210:3000'` e refaça o deploy |
| Site abre em `http` mas não em `https` | Certificado não emitido | Confira se o registro **A** do domínio já aponta para a VPS |
| Login não funciona só no celular | Está sem HTTPS | O cookie de sessão exige conexão segura |
| iPhone sem o botão de ativar | App ainda não está na tela inicial | Adicione pelo Safari e abra pelo ícone |
| Notificação entra no histórico mas não chega | Permissão revogada ou inscrição expirada | Reative em **Aparelho** |

Em qualquer um desses casos, um print dos **Logs** do container me diz quase
sempre a causa exata.
