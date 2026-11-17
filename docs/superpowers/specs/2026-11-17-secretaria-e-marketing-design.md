# Papéis de contato: Secretaria (agenda por WhatsApp) e Marketing (campanhas)

Data: 2026-11-17. Estado: **para revisão**. Origem: pedido do operador da clínica-piloto (odontologia).

## 1. Problema

A agenda real da clínica vive no CRM da franquia, que ainda não integra com o nosso. A IA de vendas não consegue verificar horário, então toda marcação termina em "vou encaminhar para a equipe" e depende de uma pessoa ler a mensagem. Os agendamentos fechados pelo humano no celular também não chegam ao CRM, e por isso não geram lembrete nem métrica.

Em paralelo, a clínica quer lançar campanhas: quem cuida do marketing manda a ideia e as fotos, e a IA cria variações do texto e envia para clientes da base.

## 2. Objetivos

1. A **secretaria** informa a agenda por mensagem, e a IA a transforma em dados que o CRM já sabe usar (`calendar_appointments`, `calendar_availability_exceptions`, jornada em `attendant_availability`).
2. A IA de vendas oferece **só horários que existem**, reserva com confirmação da secretaria e avisa quando o horário não está livre.
3. O **marketing** cria campanhas por mensagem (texto, variações, imagem), com público escolhido a cada campanha, disparo aos poucos e relatório por variação.
4. Nada disso abre caminho para a IA de vendas escrever para a equipe, nem para a equipe aparecer em funil, relatório ou follow-up.

## 3. Fora do escopo

- Integração com o CRM da franquia. A ponte é a secretaria, que lê lá e informa aqui.
- Auto-agendamento por link público.
- Mais de um atendente por agenda nesta primeira versão (uma agenda: a do dentista responsável).

## 4. Peça 0: papéis de contato

Um contato pode ter `papel_interno` = `secretaria` | `marketing` (nulo para todos os demais). Só admin e gerente atribuem, pela ficha do contato.

- Contato com papel recebe `fora_do_funil_em` (mecanismo da migration 0221): sai do funil, dos relatórios, da atribuição de anúncio e do follow-up de vendas.
- O guard `contato_fora_do_funil` em `lib/agent-engine/guardrails/before-send.ts` continua **barrando o agente de vendas**. A exceção é só para o **agente de bastidor**: o contexto de envio ganha `origem: 'bastidor'`, e o guard libera quando `origem === 'bastidor'` **e** o destinatário tem `papel_interno` **e** o papel é compatível com o tipo da mensagem (secretaria recebe pergunta de agenda e confirmação; marketing recebe prévia e relatório). Os demais gates (opt-out, bloqueio, pacing, janela) continuam valendo.
- A mensagem **recebida** de um contato com papel é roteada ao agente de bastidor, que tem prompt e ferramentas próprios. A IA de vendas nunca atende esse contato.
- **Autenticação do remetente:** só o número cadastrado aciona funções. A identidade vem do canal (número normalizado e `wa_lid` já resolvidos por `contacts`). Mensagem de qualquer outro contato nunca chega ao agente de bastidor.

## 5. Fase 1: Secretaria e agenda

### 5.1 Perguntas diárias
Cron `app/api/v1/cron/secretaria-agenda` (a cada 5 min, idempotente por org+dia+horário). Configuração em `organizations.settings.secretaria`:
`{ horarios: ["08:30","13:30","17:30"], dias: [1,2,3,4,5], fuso: "America/Sao_Paulo" }`. Em cada horário o bastidor envia:
> «Bom dia! Como está a agenda de hoje e dos próximos dias? Me manda o nome e o horário de quem está marcado e se algum dia está fechado.»

Sem resposta em 30 min: 1 lembrete. Sem resposta depois do lembrete: aviso ao admin e a agenda fica marcada como **desatualizada** (ver 5.4).

### 5.2 Leitura da resposta
O modelo converte o texto livre em JSON validado por Zod: `{ marcados: [{ nome, inicio, fim? }], dias_fechados: [{ data, motivo? }], dias_livres_confirmados: [...] }`.

- **Datas relativas** ("amanhã", "quinta") são resolvidas **no servidor**, com o relógio e o fuso da org. O modelo não sabe que dia é hoje.
- **Ambiguidade** (hora sem dia, nome sem horário) gera pergunta, nunca palpite.
- **Eco obrigatório:** o bastidor devolve um resumo e pede conferência («Entendi: ter 18/11 às 14h Maria, 15h João; quarta fechada. Está certo?»). A agenda só vira **conferida** com o "sim" ou ao ser corrigida.
- Gravação: cada marcado vira linha em `calendar_appointments` (`title` = nome, `contact_id` nulo, `created_by_kind='ai'`, `metadata.origem='secretaria'`); dia fechado vira `calendar_availability_exceptions`. A jornada semanal fica em `attendant_availability.schedule` (seg a sex, horários da clínica, sem sábado).
- Cada relato fica em `agenda_relatos` (texto bruto, JSON lido, estado `lido|conferido|corrigido`, `message_id`) para auditoria e para refazer a leitura.

### 5.3 Marcação com confirmação da secretaria
Tabela `agenda_reservas_pendentes` (`status`: `aguardando_secretaria | confirmada | recusada | expirada | cancelada`):

1. O paciente escolhe um horário entre 2 ou 3 oferecidos (`crm_find_free_slots`). A IA cria a reserva pendente e **segura o horário por 15 min** (o horário some das ofertas para os outros).
2. O bastidor pergunta à secretaria: «{tratamento} quer {dia} às {hora}. Pode confirmar?».
3. **"Sim":** a IA de vendas pede o **nome completo**, chama `crm_book_appointment`, confirma ao paciente (dia, data, hora, endereço) e o bastidor avisa a secretaria («Agendado: {nome}, {dia} {hora}, {tratamento}, tel. {número}. Lance no CRM da franquia.»).
4. **"Não" ou sem resposta em 15 min:** a reserva expira, a IA diz ao paciente «infelizmente esse horário já está ocupado», oferece outro **parecido** (mesmo turno ou dia vizinho) e pergunta qual outra disponibilidade ele tem.
5. **Paciente recusa todos os horários:** a IA pergunta quando fica bom; se o desejado estiver ocupado, repete o passo 4.
6. Se a secretaria não responde e o horário é do mesmo dia, a IA para de oferecer e chama o humano (um card com resumo).

Resposta da secretaria é lida por um classificador simples (sim | não | outro horário sugerido | dúvida). Qualquer coisa que não seja inequívoca vira pergunta de volta.

### 5.4 Agenda desatualizada
`crm_find_free_slots` ganha uma verificação: se a última agenda **conferida** for mais velha que 6 h (mesmo dia) ou 24 h (dias seguintes), a ferramenta devolve `publicou_horarios=false` com motivo `agenda_desatualizada`, e o prompt já manda não inventar vaga e passar ao humano com prazo.

## 6. Fase 2: Marketing

Tabelas: `campanhas` (`status`: `rascunho | aguardando_confirmacao | enviando | pausada | concluida | cancelada`, brief, mídia, filtro do público, totais), `campanha_variantes` (texto, ordem), `campanha_envios` (contato, variante, estado, `message_id`, `respondeu_em`, `agendou_em`).

Fluxo (todo pelo WhatsApp do contato Marketing):
1. Ele manda «nova campanha: …» com fotos e texto base.
2. O bastidor confirma o que entendeu e pergunta o público: **a cada campanha** (tratamento de interesse, última conversa em até N dias, etapa do funil). O sistema responde com a **contagem** e uma amostra de 3 nomes.
3. A IA propõe **3 a 5 variações** do texto: sem promessa de resultado, sem preço, com identificação da clínica e frase de saída («responda PARAR para não receber mais»).
4. **Envio de teste** ao próprio contato Marketing (texto e imagem exatamente como irão).
5. Confirmação: o contato Marketing responde `CONFIRMO <código de 4 dígitos>` (o código vem na prévia, para não confirmar por engano).
6. Disparo aos poucos por cron `campanha-drain`: variações em rodízio, com o nome da pessoa, a imagem anexada, **respeitando os gates de envio existentes** (pacing, janela comercial, limite diário do número).
7. A resposta do cliente cai no atendimento normal da IA de vendas, com a campanha como origem. A conversa conta para o relatório da variação.
8. Relatório ao Marketing e ao admin: enviados, respostas, agendamentos e pedidos de parar, por variação.

### 6.1 Salvaguardas que valem para qualquer público e qualquer aprovação
Essas regras são do sistema, não de quem aprova:
- **Exclusão automática:** `is_blocked`, `force_human`, `fora_do_funil`, pedido de parar, quem já recebeu a mesma campanha.
- **Teto diário** = menor valor entre o limite do número (Proteção de envio) e `settings.campanha.limite_diario` (padrão 20). Uma campanha para a base inteira leva dias, por desenho.
- **Janela** segunda a sexta, 9h às 19h.
- **"Parar" interrompe na hora:** a pessoa entra no bloqueio, e se 3% ou mais dos envios de uma campanha pedirem para parar, a campanha **pausa sozinha** e avisa o admin.
- **Aviso ao admin** a cada campanha confirmada, com público, teto e variações (informativo, não é aprovação).
- **Auditoria** de quem pediu, quem confirmou, quantos foram e quando.
- A decisão de **quem aprova** é do operador: nesta clínica, o próprio contato Marketing confirma. Fica em `settings.campanha.aprovacao = 'marketing' | 'admin'` para a regra poder mudar sem código.

## 7. Dados e segurança

- Todas as tabelas novas têm `organization_id`, RLS por organização e entram nos testes de isolamento entre organizações.
- Cada migration segue a tripla do repositório: arquivo em `supabase/migrations/`, bloco idempotente no `supabase/baseline.sql` e linha no `MANIFEST.md`.
- O bastidor nunca recebe ferramenta de envio direto: toda saída passa por `before-send` e pelos gates.
- Dados de paciente nunca vão para o log nem para as mensagens de erro; telefones aparecem mascarados nos relatórios.
- Doutrina de canal: nenhuma regra nova nomeia o provedor; envio de mídia entra como capacidade opcional do adaptador (`lint:channels`).

## 8. Fases de entrega (um PR cada, com testes e CI verde antes de qualquer release)

| PR | Conteúdo |
|---|---|
| 1 | `papel_interno`, tela de atribuição, exceção do guard para o bastidor, roteamento da mensagem do contato com papel |
| 2 | Tabelas de relato, leitura da resposta da secretaria com eco, gravação em agenda e exceções, `agenda_desatualizada` em `crm_find_free_slots` |
| 3 | Reserva pendente + confirmação da secretaria + fluxo de alternativa |
| 4 | Cron das perguntas diárias, lembrete e aviso ao admin |
| 5 | Marketing: campanha, variações, público, teste, confirmação com código, disparo escalonado, relatório |

O processo de atendimento e o follow-up de 8 toques (documento à parte) passam a usar os horários reais do PR 2 em diante. O prompt versão 11 só é publicado depois do PR 3.

## 9. Testes

- **Unidade:** leitura da resposta da secretaria (datas relativas resolvidas no servidor, ambiguidade, correção), máquina de estados da reserva, seleção de público, teto e pausa por pedido de parar.
- **Invariantes no banco** (`scripts/test-db.sh`): RLS das tabelas novas; contato com papel nunca aparece em funil, relatório nem follow-up; o guard barra o agente de vendas e libera só o bastidor para o papel correto.
- **Fim a fim com WhatsApp falso e relógio parado:** o dia inteiro da secretaria (3 perguntas, respostas, reserva e confirmação) e uma campanha de ponta a ponta, sem enviar mensagem real.
- **Prova na VPS** depois do release, sem enviar nada a paciente: campanha de teste só para o contato Marketing.

## 10. Riscos e decisões em aberto

1. **Disparo em massa pelo WhatsApp por QR** pode bloquear o número que também é o canal de vendas. As salvaguardas da seção 6.1 reduzem, não eliminam. A API oficial da Meta, com modelos aprovados, é o caminho seguro para campanhas amplas.
2. **A IA lê texto livre.** O eco e a confirmação existem justamente por isso. Mesmo assim a agenda daqui pode divergir da agenda da franquia; a secretaria continua sendo a verdade e recebe um aviso a cada marcação para lançar lá.
3. **Aprovação pelo próprio Marketing** (decisão do operador) tira a revisão humana do disparo. As salvaguardas do sistema e o aviso ao admin compensam em parte.
4. **Informações da clínica ainda pendentes:** horário de funcionamento (dias e horas), duração da avaliação, número da secretaria e do marketing.
