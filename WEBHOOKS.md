# Disparando notificações pelo n8n

Guia prático para mandar avisos da Central pelo n8n (serve igual para Make,
Zapier ou um script próprio).

---

## A ideia

Você já resolve as variáveis dentro do n8n. Então a Central não precisa de
modelo nenhum: **manda o título e o texto prontos**, e ela só entrega.

| Campo | Onde aparece |
| --- | --- |
| `titulo` | na tela do celular, na notificação |
| `texto` | completo no histórico do app |
| `tipo` | vira a etiqueta colorida (opcional) |

Isso resolve o caso do aviso comprido: o celular mostra o título e o começo da
mensagem; quem quiser o detalhe abre o app e lê tudo.

---

## Passo 1 — Criar o gatilho na Central

1. Abra o app → **Webhooks**
2. Preencha o **nome** (ex.: `Virtu — vendas`)
3. Em **Como a mensagem chega**, deixe **"Já vem pronta no JSON"**
4. Escolha o **tipo** padrão e o **público alvo**
5. **Criar webhook**
6. Copie o **endereço** e a **chave secreta**

---

## Passo 2 — Configurar o nó HTTP Request no n8n

| Campo | Valor |
| --- | --- |
| **Method** | `POST` |
| **URL** | o endereço copiado |
| **Send Headers** | ligado |
| → Header | `X-Chave-Secreta` = sua chave |
| **Send Body** | ligado |
| **Body Content Type** | `JSON` |
| **Specify Body** | `Using JSON` |

E no corpo:

```json
{
  "titulo": "✅ Venda Aprovada!",
  "texto": "A compra de *{{ $json.customer.name }}* foi confirmada com sucesso na Virtu\n\n💰 *Valor Base:* R$ {{ $json.value }}\n💸 *Valor líquido:* R$ {{ $json.value - $json.charges[0].fee }}",
  "tipo": "meta"
}
```

> Lembre de ligar a expressão (o botão de engrenagem / `fx`) no campo do corpo,
> senão o n8n manda o `{{ ... }}` como texto puro.

---

## Formatação da mensagem

| Você escreve | Resultado |
| --- | --- |
| `\n` | quebra de linha |
| `\n\n` | linha em branco entre os blocos |
| `*Valor:*` | **Valor:** em negrito no histórico |
| emojis | aparecem normalmente nos dois lugares |

Os asteriscos são removidos na notificação do celular (o sistema mostraria os
símbolos crus) e viram negrito de verdade dentro do app.

**Limites:** título até 120 caracteres, texto até 2.000.

---

## Tipos disponíveis

O campo `tipo` define a etiqueta e a cor na linha do tempo:

| Valor | Uso | Cor |
| --- | --- | --- |
| `lead` | lead novo no funil | ouro |
| `meta` | meta batida, venda aprovada | ouro |
| `alerta` | automação parada, erro | vermelho |
| `aviso` | comunicado do time | neutro |

Se você não mandar `tipo`, vale o que foi escolhido na criação do webhook.
Mandando no JSON, o **mesmo webhook** serve para vários assuntos — dá para ter
um só gatilho para a Virtu e diferenciar venda aprovada de pagamento recusado.

---

## Segurança

A chave pode ir de três formas, use a que sua ferramenta suportar:

```
X-Chave-Secreta: SUA_CHAVE          ← recomendado
Authorization: Bearer SUA_CHAVE
?chave=SUA_CHAVE                     ← último recurso, aparece em log
```

Se vazar, é só clicar em **Nova chave** no painel: a anterior para de funcionar
na hora.

---

## Testando sem o n8n

```bash
curl -X POST https://SEU-DOMINIO/hook/SEU-SLUG \
  -H "X-Chave-Secreta: SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{"titulo":"Teste","texto":"Primeira linha\n\n*Segunda* em negrito","tipo":"aviso"}'
```

Resposta esperada:

```json
{ "ok": true, "notificacao_id": 42, "entregues": 7, "falhas": 0 }
```

O `entregues` é quantos aparelhos receberam. Se vier `0`, ninguém do público
alvo ativou as notificações ainda — a notificação entra no histórico do mesmo
jeito.

---

## Se der errado

| Resposta | O que houve |
| --- | --- |
| `401 Gatilho ou chave inválidos` | endereço ou chave errados |
| `409 Este gatilho está desativado` | ligue o webhook no painel |
| `400 Envie "titulo" e "texto"` | o corpo chegou vazio ou com outros nomes |
| `429 Muitas chamadas` | passou de 120 por minuto |

No caso do `400`, a própria resposta traz um exemplo e a lista de nomes aceitos
para cada campo — o app aceita `titulo`/`title`/`assunto` e
`texto`/`mensagem`/`message`/`body`, para não travar em detalhe de nomenclatura.

---

## Se preferir o modelo com variáveis

Existe o modo alternativo, em que a Central monta a mensagem a partir de
`{{variaveis}}` do JSON cru. Útil quando quem dispara é um sistema que só sabe
mandar o payload dele sem tratamento — um CRM, por exemplo.

Nesse modo você escreve `Novo lead: {{lead.nome}}` no painel e manda o JSON
original. Para o n8n, o modo direto é mais simples: a lógica fica toda num
lugar só, no seu fluxo.
