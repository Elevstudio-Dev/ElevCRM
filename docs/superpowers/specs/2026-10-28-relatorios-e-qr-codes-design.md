# Relatórios de origem e QR codes rastreáveis — design

**Data:** 2026-10-28 · **Pedido do dono (Carlos):** "vamos criar uma tela de relatório, e uma tela que cria QR codes
para conseguirmos medir também". **Plano de execução:**
[`docs/superpowers/plans/2026-10-28-relatorios-e-qr-codes.md`](../plans/2026-10-28-relatorios-e-qr-codes.md).

## 1. O problema, medido

O produto já GRAVA de onde parte dos leads vem, mas ninguém consegue LER isso:

- **Anúncio "Clique para o WhatsApp" do Meta** — `lib/leads/atribuicao-de-anuncio.ts` estampa no contato (primeiro
  toque) plataforma, título, corpo, link e `ctwa_clid`; o lead que nasce da conversa copia `source = 'meta_ads'`,
  `source_metadata` e a tag `Meta_ads` (`lib/leads/nascimento-do-lead.ts`).
- **Formulário/landing page** — `POST /api/v1/webhooks/in/[token]` grava `utm_*` no `source_metadata` do lead
  (`source = 'webhook'`) e em `webhook_lead_captures.utm`.
- **Resto** — `crm_leads.source` é texto livre: `whatsapp`, `manual`, `import`, `ai_agent`, `reactivation`…

Não há tela que agregue isso, e **não há como medir mídia offline** (cartaz, panfleto, cartão, vitrine): quem chega
por um QR genérico do WhatsApp vira `source = 'whatsapp'`, indistinguível de quem já tinha o número salvo.

Na VPS em 2026-10-28: 15 leads, todos `whatsapp`; 0 contatos com atribuição de anúncio; 0 com `utm_*`.

## 2. Decisões do dono (perguntadas antes do desenho)

| Pergunta | Decisão |
|---|---|
| Como o QR mede | **Conta leitura + conversa**: o QR aponta para um link do próprio CRM (`/q/<código>`) que conta a leitura e redireciona para o WhatsApp com a mensagem pronta. Mede leituras → conversas → leads → vendas. |
| O que vai na mensagem pronta | **Frase + código curto**: a frase é do dono (ex.: "Olá! Vi o cartaz da recepção") e o sistema acrescenta ` #R7K2QH`. O código identifica o QR. Se o cliente apagar o código, aquela conversa não é atribuída (limite declarado). |
| O que o relatório mostra | As quatro: **leads por origem**, **até a venda** (ganhos, perdidos, conversão, R$ ganho), **funil do QR** (leituras → conversas → leads → vendas), **evolução no tempo** (por dia, filtro 7/30/90 dias ou datas). |
| Onde fica e quem vê | Aba nova **"Relatórios"**, só **gestor+** (manager e admin). |
| A barra tem limite de 5 abas (regra com teste) | **Sexta aba só para gestor+**. Atendente/viewer continuam vendo 5. O teste do limite passa a ser "≤ 6, e quem não é gestor vê 5". |
| Cliente que já existe lê um QR | **Conta a conversa sempre; lead só se for novo.** A conversa entra no funil do QR. Se a pessoa não tem negócio aberto, o lead novo nasce com origem QR; se já tem, a origem do negócio NÃO muda (primeiro toque). |

## 3. Arquitetura

```
 cartaz ──QR──► GET /q/R7K2QH ──(conta leitura)──► 302 https://wa.me/55DDDNUMERO?text=Olá!…%20#R7K2QH
                     │                                              │
                     ▼                                              ▼ cliente envia
              qr_code_leituras                       webhook do canal → ingest → aplicarEfeitosPosEntrada
                                                                    │
                                     1 opt-out → 1b RECONHECER QR → 2 abrirDemanda(origem QR) → …
                                                     │                    │
                                                     ▼                    ▼
                                             qr_code_conversas     crm_leads.source = 'qr_code'
                                                                   source_metadata.qr_code_id/nome/codigo
                                                                   tags = ['QR code']

 /app/relatorios ──► GET /api/v1/relatorios/origens ──► fn_relatorio_de_origens + fn_relatorio_de_origens_por_dia
 /app/relatorios/qr-codes ──► GET/POST/PATCH /api/v1/qr-codes + GET /api/v1/relatorios/qr-codes ──► fn_relatorio_de_qr_codes
```

### 3.1 Dados (migration 0220)

- **`qr_codes`** — `organization_id`, `codigo` (6 caracteres do alfabeto sem ambíguos `23456789ABCDEFGHJKMNPQRSTUVWXYZ`,
  **único na instalação** — a rota pública não sabe a organização), `nome` (1–80), `mensagem` (1–300),
  `channel_session_id` (para qual número; `on delete set null`), `arquivado_em`, `created_by_user_id`, timestamps.
  Arquivar em vez de apagar: o QR já impresso continua existindo no mundo, e o histórico dele também.
- **`qr_code_leituras`** — uma linha por leitura contada: `qr_code_id`, `organization_id`, `lida_em`,
  `dispositivo` (`celular|computador|outro`). **Sem IP e sem user-agent gravados** (minimização LGPD — a pergunta é
  "quantos leram", não "quem leu").
- **`qr_code_conversas`** — `qr_code_id`, `conversation_id`, `contact_id` (`set null`), `message_id` (`set null`),
  `lead_id` (o lead que nasceu desta mensagem, `set null`), `criada_em`; **`unique (qr_code_id, conversation_id)`**: a
  mesma conversa conta uma vez por QR (mandar o código de novo não infla o número).
- **RLS**: as três exigem **manager+** para SELECT (molde de `webhook_lead_captures`, 0174); `qr_codes` aceita
  INSERT/UPDATE de manager+ da própria org; `leituras` e `conversas` só o service role escreve.
- **Três funções de relatório** (`security invoker`, `stable`, filtram `organization_id = p_org`, revogadas de
  `public`/`anon`, concedidas a `authenticated`): `fn_relatorio_de_origens`, `fn_relatorio_de_origens_por_dia`,
  `fn_relatorio_de_qr_codes`. Agregar no banco porque o PostgREST corta em 1.000 linhas — buscar leads e somar em JS
  mentiria em silêncio na primeira organização com 1.001 leads no período.
- **Índice** `crm_leads ((source_metadata->>'qr_code_id')) where source = 'qr_code'`.

### 3.2 A rota pública `/q/[codigo]`

- Fora de `/api` e curta de propósito: o QR fica menos denso (mais fácil de ler impresso pequeno).
- Entra em `PUBLIC_PATHS` ancorada: `/^\/q\/[A-Za-z0-9]{1,16}$/`.
- Código normalizado (maiúsculas, alfabeto, 6 chars); inexistente/arquivado → página HTML neutra (sem marca)
  "Este QR code não está mais ativo", status 404/410. Sem número de WhatsApp resolvível → página "Este QR code ainda
  não está ligado a um número", 503.
- **Conta a leitura** só quando: método GET, user-agent não é robô/pré-visualização (`facebookexternalhit`,
  `WhatsApp/`, `bot`, `crawler`, `spider`, `preview`, `Slackbot`, `TelegramBot`, `Discordbot`) e o limitador
  `checkRateLimit("qr_leitura:<qr>:<ip>", 10, 60)` permite. Fora disso **redireciona mesmo assim** — o limitador
  protege a contagem, nunca bloqueia a pessoa.
- Redireciona `302` para `https://wa.me/<dígitos>?text=<encodeURIComponent(mensagem + " #" + codigo)>`, com
  `Cache-Control: no-store` e `Referrer-Policy: no-referrer`.
- Número: o `phone_number` do `channel_session_id` do QR; se nulo, o primeiro canal `WORKING` da org com número.

### 3.3 O reconhecimento na entrada

Novo passo **1b** em `lib/channels/pos-entrada.ts`, entre opt-out e `abrirDemanda` (os dois canais passam por ali):

1. `extrairCodigoDaMensagem(texto)` — procura `#XXXXXX` (alfabeto, case-insensitive, fronteira de palavra).
2. Conversa de grupo → ignora (`conversations.is_group`).
3. Busca `qr_codes` por `(organization_id, codigo)` — código de outra organização não casa. QR arquivado **conta**
   (a atribuição é um fato; arquivar só tira o QR de circulação).
4. `insert qr_code_conversas` (23505 = já contado, silencioso).
5. Devolve `{ id, nome, codigo }` para `abrirDemanda`, que chama `garantirLeadDaConversa(..., { origem })`.

`garantirLeadDaConversa` ganha `origem?` opcional. Precedência da origem do lead NOVO: **QR desta mensagem > anúncio
estampado no contato > `whatsapp`**. Lead já aberto não muda (`ja_existe`). Quando o lead nasce, a linha de
`qr_code_conversas` recebe o `lead_id`.

### 3.4 As telas

- **`/app/relatorios`** (aba 6, gestor+) — filtro de período (7/30/90 dias, personalizado), 4 números no topo
  (leads, ganhos, conversão, R$ ganho), tabela **"Leads por origem"** agrupada (QR codes · Anúncios · Formulários ·
  WhatsApp direto · Manual · Importados · IA/Retomada · Outros) com detalhe expansível (cada QR pelo nome, cada anúncio
  pelo título, cada formulário pela campanha), colunas leads/abertos/ganhos/perdidos/conversão/R$ ganho, e o gráfico
  **"Leads por dia"** empilhado por grupo.
- **`/app/relatorios/qr-codes`** (gestor+, sem aba própria — link no topo da tela de relatórios) — lista de QRs com a
  imagem, nome, link, mensagem final, número, funil do período (leituras → conversas → leads → vendas com %), avisos
  ("10+ leituras e nenhuma conversa: o código pode estar sendo apagado ou o número está errado"; "sem número ligado"),
  ações: **Baixar PNG** (1024 px), **Baixar SVG**, **Copiar link**, **Editar**, **Arquivar/Reativar**. Botão
  **Novo QR code** abre diálogo: nome, número de WhatsApp (canais com telefone), mensagem (padrão "Olá! Gostaria de
  saber mais.") e a **prévia da mensagem final** com o código.
- **Card do funil**: a linha de origem (1.22.0) passa a dizer **"QR: Cartaz da recepção"** para `source = 'qr_code'`.

O link do QR usa `window.location.origin` de quem cria — é o domínio público pelo qual o gestor já acessa o CRM. A
tela mostra o link por extenso para conferência.

## 4. Sistema vivo (checklist da `docs/doctrine/sistema-vivo.md`)

- **Entrada:** leitura em `/q/<código>`; mensagem com `#código` na ingestão.
- **Saída:** relatório e funil do QR; origem no card do lead.
- **Atividade/log:** auditoria `qr_code.created`, `qr_code.updated`, `qr_code.archived`, `qr_code.restored`; o
  `lead_created` da timeline leva `qr_code_id` no payload; leitura é contada (não auditada: alto volume, sem ator).
- **Tela e porta:** aba "Relatórios" (registry, `principal: 6`, `minRole: manager`); QR codes no registry sem aba.
- **Anti-morte / laço de retorno:** o card do QR acusa "leituras sem conversa" e "sem número ligado" — é o que muda
  quando a funcionalidade erra (o gestor vê e corrige o número ou a mensagem).

## 5. Limites declarados (não prometer além disso)

- Cliente que apaga o `#código` antes de enviar não é atribuído; abre como `whatsapp`.
- A mesma conversa conta uma vez por QR (escanear de novo não soma conversa; soma leitura).
- Leitura não é pessoa única: duas leituras do mesmo celular em minutos diferentes contam duas (sem IP gravado, não
  há como deduplicar sem guardar dado pessoal).
- Google Ads continua sem atribuição automática (precisaria de landing page com `gclid`).
- Valor ganho soma só leads em BRL (ou sem moeda).
- O reconhecimento do QR **não** libera a IA (`campanhas_whatsapp` é outro mecanismo e continua igual).

## 6. Fora de escopo

Exportar CSV; relatório por atendente (já existe em Desempenho); atribuição multi-toque; encurtador para outros
destinos; QR para Instagram/site.
