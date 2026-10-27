# A marca Elev Studio no Elev CRM

Este documento diz **o que é a identidade da Elev Studio dentro do sistema**, de onde cada valor veio e
**como ela é aplicada** numa instalação. O design system de origem (Sage) continua descrito em
[`docs/design-system/`](../design-system/); aqui está só o que a Elev mudou por cima dele.

## A identidade

Lida do site `elevstudio.com.br` e dos posts da marca — não é palpite.

| Papel | Valor | Onde aparece |
|---|---|---|
| Roxo Elev (cor de ação) | `#67298f` | botões, aba ativa, balões de saída, foco — **por configuração** (abaixo) |
| Roxo profundo | `#53266c` | degraus escuros da rampa |
| Fundo do claro | `#f4f2ef` | `--color-bg` no tema claro (o cartão branco aparece sobre ele) |
| Fundo do escuro | `#0e0a11` | `--color-bg` no tema escuro: o preto da Elev com um fio de violeta |
| Ícone | `lib/branding/elev/icone.ts` | barra superior, ícone da aba, ícone do iPhone, painel de entrada |
| Títulos e marca | IBM Plex Sans | `h1…h4`, nome na barra, painel de entrada |
| Texto corrido | Source Sans 3 | o resto — a mesma dupla do site |

O ícone vem do arquivo vetorial que o próprio site `elevstudio.com.br` publica como ícone. Os quatro
caminhos foram copiados do original, sem redesenhar (`lib/branding/elev/icone.ts` diz como).

## Como a cor entra na instalação

A cor de ação **não é código**: o CRM deriva 11 tons (claro e escuro, com piso de contraste) de UM hex, e
quem fornece o hex é a configuração da marca da instalação:

- **Pela tela:** `/admin/marca` → cor da marca `#67298f`.
- **Pelo `.env`** (semente e piso de rollback): `APP_ACCENT_HEX="#67298f"`. É também o que os e-mails de
  acesso leem (`bash hostgator-setup-kit/marca-emails.sh`).

Quem não configura nada fica com a Sage do design system, como sempre.

**O logo da instalação não é mais necessário.** O ícone da Elev agora vem do código e aparece sempre na
barra superior — se `/admin/marca` também tiver um logo (por exemplo o próprio ícone, enviado antes
desta versão), ele aparece **ao lado**, duplicado. Remova o logo da instalação em `/admin/marca`.
(O logo de uma *organização* cliente continua funcionando: aparece depois do selo da Elev.)

## O que mudou no código, e onde

| O quê | Arquivo |
|---|---|
| Fontes | `app/layout.tsx` (`next/font`) + `--font-sans` / `--font-heading` em `app/globals.css` |
| Neutros do escuro, fundo do claro, semânticas | `app/globals.css` (os três blocos de token) **e** `lib/branding/regua-do-produto.ts` |
| Selo na barra superior | `components/branding/IconeElev.tsx`, `components/shell/MarcaNaBarra.tsx` |
| Tela de entrada | `components/branding/PainelDaMarca.tsx`, `app/(public)/layout.tsx` |
| Ícone da aba e do iPhone | `app/icon.tsx`, `app/apple-icon.tsx`, `lib/branding/elev/desenho-do-icone.tsx` |
| Cor por contato | `lib/contacts/cor-do-avatar.ts` |
| Espera do cliente (Inbox) | `components/inbox/ConversationListItem.tsx` (usa `lib/inbox/tempo-sem-resposta.ts`) |
| Cor das etapas do funil | `lib/kanban/cor-da-etapa.ts` |
| Tom por seção dos hubs | `components/shell/NavHub.tsx` |

### Mexeu na paleta? A régua é gerada

`lib/branding/regua-do-produto.ts` é o espelho congelado do `app/globals.css`, e
`tests/unit/branding-regua-do-produto.test.ts` reprova quando os dois divergem. Os testes de contraste
(`branding-contraste`, `branding-pares-pintados`) fixam razões medidas: ao mudar um fundo, os números mudam
— **re-meça por fora do código** (fórmula WCAG) antes de atualizá-los, como foi feito em 27/10/2026.

## Como as cores foram escolhidas

- **Semânticas mais vivas, mesmo contraste.** Verde, âmbar, vermelho e azul firmes: a luminosidade (OKLCH)
  de cada token foi preservada e só o croma subiu — por isso a razão de contraste de cada par ficou igual
  à de antes (conferido).
- **Neutros do escuro:** mesma luminosidade dos de antes, matiz trocado do bege-oliva para o violeta
  (312°, o do preto da Elev), e os três mais escuros um pouco mais fundos.
- **A cor nunca vai sozinha.** Etapa de ganho/perda tem ícone e texto; a espera do cliente tem relógio e
  "Aguardando há …"; o avatar colorido tem as iniciais. Quem não distingue cores perde nada.
- **O âmbar segue querendo dizer "atenção".** Por isso as etapas abertas do funil usam a rampa da marca
  (progressão do claro ao escuro), e não uma escala de semáforo.

## O que ainda NÃO está feito (dito para não virar surpresa)

- Ícone do PWA em 192 e 512 px (hoje há 64 e 180): o navegador oferece "instalar" mas com o ícone menor.
- Imagem de compartilhamento (Open Graph) do produto.
- Fonte por organização: continua não sendo configurável (resolve em build).
