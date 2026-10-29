# Contato "Fora do funil" — design

**Data:** 2026-10-29 · **Pedido do dono (Carlos):** uma função para transformar um contato em "não lead" — equipe dos
clientes, prestadores de serviço, gente que a gente vai procurar — e tirar essas pessoas do radar da IA e do relatório.
**Plano:** [`../plans/2026-10-29-contato-fora-do-funil.md`](../plans/2026-10-29-contato-fora-do-funil.md).

## 1. O problema, medido

Hoje toda pessoa que escreve vira lead (`garantirLeadDaConversa`), a IA responde a todo contato e o relatório conta
todo lead. Quem não é cliente (equipe, prestador, fornecedor) polui os três. Os marcadores que existem NÃO servem:

| Marcador | O que é | Por que não serve |
|---|---|---|
| `contacts.is_blocked` | opt-out de LGPD ("quero sair") | bloqueia TODO envio, inclusive o humano; é obrigação legal, não classificação |
| `contacts.force_human` | a IA assumiu que precisa de humano | a própria IA/fluxos o ligam e o humano o devolve; não é permanente nem é "quem é a pessoa" |

E `crm_leads.status` só admite `open | won | lost`: **não existe "arquivado"**. Marcar o negócio como `lost`
mantém o card no funil e infla "perdidos" (derruba a conversão). Leads são lidos em 75 pontos de 52 arquivos.

## 2. Decisões do dono (perguntadas)

| Pergunta | Decisão |
|---|---|
| Nome | **"Fora do funil"** (es: "Fuera del embudo") |
| Tipo | **Tipos que o dono cadastra** (ex.: Equipe, Contador, Dentista parceiro); renomear e arquivar |
| Negócio que a pessoa já tem | **Sai do funil e do relatório**, histórico guardado, **volta se desmarcar**; confirmação mostrando quantos |
| Inbox | **Continua aparecendo, com selo**; só a IA se cala e nenhum negócio nasce |
| (padrões propostos e aceitos) | qualquer atendente (agent+) marca e desmarca; lembrete de consulta segue saindo; negócio com venda ganha também sai, após confirmação |

## 3. Arquitetura

```
 ficha / cabeçalho da conversa / lista (em massa) ──► PATCH /api/v1/contacts/fora-do-funil ──► contacts.fora_do_funil_em
                                                                                                   │ trigger (definer)
                          ┌────────────────────────────────────────────────────────────────────────┤
                          ▼                                                                        ▼
        crm_leads.fora_do_funil = true (espelho)                              AI: decidirElegibilidade → "fora_do_funil"
        └► some do quadro, relatório, Desempenho, radar,                       (drain, turno, follow-up de texto fixo, runtime
           follow-up, alertas, contagens                                        legado, handoff) + before-send (veto final)
        nasce lead? NÃO (nascimento, POST /leads, formulário)
```

### 3.1 Dados (migration 0221)
- **`tipos_fora_do_funil`** — `organization_id`, `nome` (1–40), `arquivado_em`, `created_by_user_id`; único por
  (org, `lower(nome)`) entre os não arquivados. RLS: SELECT de qualquer membro; INSERT/UPDATE manager+.
- **`contacts`**: `fora_do_funil_em timestamptz`, `fora_do_funil_tipo_id uuid` (`on delete set null`),
  `fora_do_funil_por uuid`. Nulo = é do funil (o padrão). Índice parcial `where fora_do_funil_em is not null`.
- **`crm_leads.fora_do_funil boolean not null default false`** — ESPELHO do contato, mantido só pelo banco:
  trigger `after update of fora_do_funil_em on contacts` (security definer) atualiza os leads do contato; trigger
  `before insert on crm_leads` herda do contato. Ninguém escreve essa coluna à mão. Índice parcial dos que estão fora.
- As **três funções de relatório** (0220) ganham `and not l.fora_do_funil`.

### 3.2 A regra da IA (o "radar")
`decidirElegibilidade` é o ponto único que o drain, o turno, o follow-up de texto fixo, o runtime legado e o handoff
consultam. Ganha o motivo **`fora_do_funil`**, que vence todos os outros (inclusive o gate aberto). As duas consultas
(pg e Supabase) leem `fora_do_funil_em`. Defesa em profundidade: `before-send` ganha o veto
`contato_fora_do_funil` (código próprio — não diz "o lead optou por sair", que seria mentira).

### 3.3 Onde o negócio deixa de existir
Filtram `fora_do_funil = false` as telas e rotinas que MOSTRAM ou AGREGAM negócios: quadro, listagem e busca de leads,
em risco / reativações / propostas, Desempenho, radar de risco e seus workers, follow-up (matrícula e gatilho),
alertas e push, contagens de funil, resumo do CRM do contato, ferramentas MCP de operação/retenção, e o SQL do
relatório. **Não filtram** (e a guarda exige dizer por quê): operações POR ID (abrir, mover, ganhar, perder um negócio
que já se tem na mão), ciclo de vida e LGPD (anonimizar/exportar precisa ver tudo), administração da plataforma.

**Cerca que morde:** `tests/unit/leads-fora-do-funil-guarda.test.ts` lista todo arquivo de `lib/` e `app/` que lê
`crm_leads` e exige, para cada um, ou o filtro (`fora_do_funil` no texto) ou uma entrada na allowlist COM motivo.
Arquivo novo que leia leads sem uma das duas coisas reprova. A allowlist só encolhe.

### 3.4 Nascimento
`garantirLeadDaConversa` recusa com motivo novo `contato_fora_do_funil` (logado, como os demais). `POST /api/v1/leads`
devolve 409 com mensagem em português. O webhook de formulário registra o desfecho "não entrou" e não cria lead.
Importação de planilha pula a linha e a conta no relatório da importação.

### 3.5 Telas
- **Marcar/desmarcar:** ficha do contato, cabeçalho da conversa e seleção em massa na lista de contatos. Diálogo com
  tipo (opcional, e criar tipo ali mesmo para gestor+) e a contagem do que sai ("2 negócios abertos, 1 ganho de R$ …").
- **Selo "Fora do funil" (+ tipo)** na lista de contatos, na linha e no cabeçalho do Inbox; a explicação do silêncio
  da IA (`comandoDaConversa`) diz o motivo, em palavras do dono.
- **Lista de contatos:** filtro "Fora do funil" e por tipo.
- **Configurações › Tipos de contato fora do funil** (manager+): criar, renomear, arquivar.

### 3.6 Sistema vivo
Entrada: marcar (tela/lote). Saída: selo, motivo na conversa, contagens. Registro: auditoria
`contact.fora_do_funil_marcado/desmarcado` (autor, quantos, tipo e o que saiu do funil) e
`tipo_fora_do_funil.criado/renomeado/arquivado/reativado`. (A linha na timeline do NEGÓCIO foi cortada: exigiria um
tipo novo no vocabulário de atividades e na constraint do banco, para repetir o que a auditoria já guarda.) Laço de retorno: o diálogo mostra quantos negócios saem; a lista filtra quem está fora.

## 4. Limites declarados
- Não há detecção automática: alguém marca. Os contatos de hoje ficam como estão até a equipe classificar.
- Mensagem em massa (broadcast), se existir fora do motor da IA, NÃO é barrada por este marcador.
- Lembrete de consulta continua saindo (aviso do sistema, não conversa da IA).
- A prova de "a IA ficou calada" é por mensagem simulada, nunca com WhatsApp real.
- Exportação de LGPD e telas de administração da plataforma continuam vendo tudo.

## 5. Fora de escopo
Detecção automática de "não é cliente"; tipos com cor; regras diferentes por tipo; marcar por número antes de o contato existir.
