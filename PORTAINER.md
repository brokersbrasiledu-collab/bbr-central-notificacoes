# Subir na VPS pelo Portainer

Guia para a **sua** VPS: Docker Swarm, Traefik na rede `AutoNet` e Portainer.
Se travar em algum passo, pare ali e me avise — não tente adivinhar.

**Nada aqui encosta no que já roda na sua VPS.** O app vira um serviço separado,
com volume separado. A stack do Traefik não é alterada em momento nenhum: ele
descobre o app sozinho. Se der errado, você remove a stack e a VPS fica
exatamente como estava.

---

## O domínio

O endereço está escrito **direto** no `docker-compose.yml`:

```
traefik.http.routers.bbrpush.rule=Host(`avisos.brokersbrasil.com`)
```

Não é variável de propósito. O Portainer já deixou essa variável chegar vazia
uma vez, e o resultado foi uma rota que o Traefik nunca criou — o site
respondia `404` com erro de certificado, sem nada no log ligando uma coisa à
outra. Escrito no arquivo, não há como dar errado, e a correção sobrevive a
qualquer *Pull and redeploy*.

**Para trocar de domínio** mexa em dois lugares: nesta linha do
`docker-compose.yml` e na variável `APP_URL` da stack, que precisa apontar para
o mesmo endereço (é ela que monta os endereços dos webhooks no painel).

---

## Já está pronto

| | Estado |
| --- | --- |
| Código no GitHub | ✅ [bbr-central-notificacoes](https://github.com/brokersbrasiledu-collab/bbr-central-notificacoes) |
| Imagem construída e publicada | ✅ `ghcr.io/brokersbrasiledu-collab/bbr-central-notificacoes:latest` |
| Imagem pública, sem senha para baixar | ✅ o Portainer pega direto |
| Rede, entrypoint e certificado do Traefik | ✅ já preenchidos com os valores da sua VPS |

Sobram **três coisas** para você fazer: apontar o domínio, criar a stack e
instalar no celular.

---

## Passo 1 — Apontar o domínio

Faça primeiro, porque é o que mais demora a propagar.

No painel onde fica seu domínio, crie um registro **A**:

- **Nome:** `avisos`
- **Aponta para:** o IP da sua VPS

A Let's Encrypt só emite o certificado depois que esse endereço responder.

---

## Passo 2 — Gerar as variáveis

Na sua máquina, dentro da pasta do projeto:

```bash
npm run variaveis -- https://avisos.brokersbrasil.com
```

Esse é o único comando do guia inteiro, e roda no **seu computador**, não na
VPS. Ele imprime um bloco pronto. Antes de colar, ajuste **uma linha**:

- **`ADMIN_SENHA`** → a senha com que você vai entrar no app

O resto já vem certo, inclusive o endereço da imagem e as chaves de push.

---

## Passo 3 — Criar a stack no Portainer

1. Portainer → menu da esquerda → **Stacks** → **+ Add stack**
2. **Name:** `bbr-push`
3. **Build method:** **Repository**
4. Preencha:
   - **Repository URL:**
     `https://github.com/brokersbrasiledu-collab/bbr-central-notificacoes`
   - **Repository reference:** `refs/heads/main`
   - **Compose path:** `docker-compose.yml`
   - **Authentication:** deixe **desligado** (o repositório é público)
5. Role até **Environment variables** → **Advanced mode**
6. Cole o bloco do Passo 2
7. **Deploy the stack**

> Prefere não usar o GitHub? Escolha **Web editor** em vez de *Repository*, abra
> o arquivo `docker-compose.yml` da pasta do projeto e cole o conteúdo inteiro.
> Funciona igual.

---

## Passo 4 — Conferir

1. Portainer → **Services**
2. O serviço `bbr-push_bbr-push` precisa mostrar **1 / 1**

Depois abra `https://avisos.brokersbrasil.com`. Se aparecer o cadeado e a tela
de login, acabou — o Traefik pediu o certificado sozinho.

Se der erro de certificado, espere 2 minutos e recarregue. A emissão não é
instantânea.

---

## Passo 5 — Instalar no celular

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

O ciclo tem três etapas, e só a última é sua:

| | Quem faz |
| --- | --- |
| 1. Alterar o código e enviar ao GitHub | eu |
| 2. Construir e publicar a imagem nova | automático (~1 min) |
| 3. **Portainer → Stacks → `bbr-push` → Pull and redeploy** | você |

O volume não é tocado: contas, aparelhos e histórico continuam lá. O app antigo
desliga **antes** de o novo subir, então nunca há dois processos escrevendo no
banco ao mesmo tempo.

> **Não precisa do "Re-pull image"** (que é recurso pago). Em Swarm, o
> `docker stack deploy` consulta o registro e fixa a imagem pelo digest a cada
> deploy — digest novo, tarefa nova.

### Confirmar que a versão nova subiu

Abra no navegador:

```
https://avisos.brokersbrasil.com/api/saude
```

Resposta:

```json
{ "ok": true, "versao": "a1b2c3d", "push": true, "ambiente": "production" }
```

O campo `versao` é o commit que gerou a imagem em execução. Compare com o
commit mais recente no GitHub: se bater, a VPS está com a versão nova. Se não
bater depois de alguns minutos, me avise — troco a estratégia para etiquetas
fixas de versão, que forçam a atualização.

Vale conferir isso **antes** de reportar que uma correção não funcionou. Quase
sempre é o deploy que ainda não subiu, não o código.

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
| Serviço em **0 / 1** | Falta alguma variável | Abra os **Logs** do serviço: a primeira linha diz qual |
| **404 page not found** no site | O Traefik não casou a rota | Confira o `Host(...)` no `docker-compose.yml`: só o host, sem `https://` e sem barra no fim |
| Erro de certificado que não passa | O registro **A** não propagou | Confira o DNS; veja os **Logs** do Traefik |
| Login funciona no PC mas não no celular | Está entrando por `http` | Use sempre `https://` |
| iPhone sem o botão de ativar | App ainda não está na tela inicial | Adicione pelo Safari e abra pelo ícone |
| Notificação entra no histórico mas não chega | Permissão revogada ou inscrição expirada | Reative em **Aparelho** |

Em qualquer caso, um print dos **Logs** do serviço quase sempre me dá a causa
exata.

---

## Uma observação sobre o repositório público

O código está visível para qualquer pessoa. Nenhuma senha ou chave vai junto —
o `.env` fica de fora, e `JWT_SECRET`, chave VAPID e senha do admin existem só
nas variáveis do Portainer.

Se um dia quiser fechar: **Settings** → **General** → role até o fim →
**Change repository visibility** → *Make private*. Nesse caso a imagem também
vira privada, e o Portainer vai precisar de uma credencial para baixá-la — me
avise que eu te passo esse passo extra.
