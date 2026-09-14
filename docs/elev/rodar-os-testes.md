# Rodar os testes na máquina de desenvolvimento

## O comando que roda tudo

```bash
pnpm elev:testar            # a Definition of Done inteira, ~55 min
pnpm elev:testar --sem-e2e  # só as camadas rápidas, ~20 min — para mudança sem UI
```

`scripts/elev-testar-tudo.sh` roda **gov:verify e test:db em paralelo, depois
test:shell, depois a E2E** (build, seeds do CI, e as duas listas do CI, lidas
por `scripts/listas-do-ci.ts` — o mesmo parser do gate
`e2e-cobertura-completa` — com o mesmo `env` do passo do CI), guarda um log
por camada, sem cor, em `.superpowers/testar-tudo/<data-hora>/` e termina com
um veredito. Se o build ou o seed da E2E falhar, as partes **não rodam** — o
Playwright serviria o `.next` da rodada anterior. Existe porque
`pnpm gov:verify` **não** cobre `test:db` nem `test:e2e` (CLAUDE.md), e em
setembro a `main` ficou quatro dias com a E2E vermelha enquanto cada sessão
rodava só "o recorte relevante".

As seções abaixo explicam cada camada — para rodar uma só, ou para ler o
vermelho.

## 1. Unitária — minutos, roda sempre

```bash
pnpm gov:verify   # typecheck + lint + lint:channels + lint:role-rank + test:unit
```

Verde aqui não prova produto, prova que as peças fazem o que dizem.
Referência de tamanho: 670 arquivos, 7.309 testes (2026-09-13).

## 1b. Invariantes de banco — ~10 min, obrigatória em mudança de schema

```bash
pnpm test:db
```

Sobe um Postgres efêmero (`pgvector:pg15`, o piso que o produto promete),
aplica o `baseline.sql` em modo instalação **e** em modo atualização, e roda os
invariantes de isolamento entre organizações. É a única prova de que o RLS
segura — `test:unit` exclui `tests/invariants/**` de propósito. Precisa do
Docker de pé. Referência: 151 arquivos, 1.198 casos (2026-09-13).

## 1c. Kit de instalação — ~1 min, obrigatória em Dockerfile/compose/kit

```bash
pnpm test:shell
```

Os guards do `update.sh`, do dono do projeto, do entrypoint do scheduler e os
validadores do instalador. É o único gate que exercita o que o cliente roda na
VPS.

## 2. E2E — ~30 minutos, e **precisa de seed**

```bash
pnpm e2e:build       # o build de produção com o .env.e2e — o Playwright sobe `next start` dele
pnpm elev:semear     # ANTES. Sem isto o resultado não vale.
pnpm exec playwright test
```

Rodar `playwright test` sem lista roda TUDO em `tests/e2e/`, inclusive o que o
CI deixa fora de propósito (`vps-fresh-onboarding`, seção 3, e
`inbox-tempo-real`, instável por WebSocket — issue upstream #347). O
`elev:testar` roda as duas listas do CI, que é a medida que vale.

Duas armadilhas medidas em 2026-09-12: o build reescreve o `.next` — se o
servidor de teste da 3100 estiver servindo dele, derrube antes
(`fuser -k 3100/tcp`); e specs de bloco **serial** que dependem de banco limpo
(`agenda-tela-do-produto`, "trilhas de cor") reprovam num banco com 24 usuários
e abortam o resto do arquivo — no CI o banco nasce limpo. Ler o vermelho antes
de acusar o produto.

### Por que o `elev:semear` existe

O CI semeia o banco com cinco scripts antes de rodar o E2E. Rodar o Playwright
local sem eles não dá "quase o resultado do CI" — dá um resultado **diferente**,
com falhas que não são defeito nenhum.

Medido em 2026-09-03: as duas specs de `central-de-avisos-capacidades`
falhavam local e passavam no CI. A diferença inteira era
`seed-e2e-capacidades-ausentes`, que cria o aviso pelo emissor real. Sem ele o
aviso não existe, a tela não tem o que mostrar, e o teste acusa a tela.

Duas falhas fantasma custam mais caro do que parecem: elas ensinam a ignorar
vermelho. Quando todo mundo já sabe que "aquelas duas sempre falham", a
terceira — a de verdade — passa junto.

### A armadilha do arquivo de env

O workflow do CI chama os seeds com `--env-file=.env.local`, porque **lá** é o
`.env.local` que tem o conjunto completo. Aqui quem tem é o `.env.e2e`, e o
`.env.local` guarda outra coisa (as variáveis de marca).

Copiar a linha do CI ao pé da letra falha assim:

```
NEXT_PUBLIC_SUPABASE_URL: Invalid input: expected string, received undefined
```

O erro aponta para o Supabase e o que faltou foi o arquivo de env. O
`elev:semear` escolhe o arquivo que **existe** em vez de supor qual é.

### Quando o CI ganhar um seed novo

Ele entra em `scripts/elev-semear-e2e.sh`. A lista de lá é cópia da de
`.github/workflows/e2e.yml`; se as duas divergirem, a diferença volta a aparecer
disfarçada de defeito. Conferir na sincronização mensal
([sincronizar-com-upstream.md](sincronizar-com-upstream.md)).

## 3. `vps-fresh-onboarding` — não roda aqui, e é para ser assim

Essa spec falha nesta máquina de propósito:

```
esta suite APAGA dados da organizacao que resolver aqui, e nao achou o dono
(dono@qa.local).
```

Ela testa a instalação **do zero**: banco vazio, dono criado pelo
`bootstrap-owner.ts`, WAHA e Redis de verdade, sem Resend. Fica fora da lista do
CI por isso, e se prova numa VPS.

O `throw` é proposital, e vale mais que um `skip`: a doutrina do repo
(`docs/testing/user-journey-map.md`) diz que **um `skip` silencioso é
indistinguível de um `pass`**. Além disso a suíte é destrutiva — ela zera
`onboarded_at` e apaga `ai_agents` e `channel_sessions` da organização que
resolver. Em 2026-09-03 ela resolveu "a primeira" e derrubou o onboarding e a
sessão de WhatsApp de uma instalação real de trabalho. Um teste destrutivo que
não sabe em quem está mexendo deve parar, nunca escolher alguém.

## Onde os números ficam

`pnpm elev:estado` remede tudo e reescreve [ESTADO.md](ESTADO.md). Rodar depois
de mexer no produto, para a documentação não envelhecer sozinha.
