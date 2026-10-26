# Lembrete de consulta por WhatsApp — desenho

> Status: em construção (2026-10-23). Fecha a pendência declarada na migration 0194:
> *"Ligar lembrete por padrão fica com o dono do produto NO DIA em que o disparador nascer."*

## O problema

A agenda grava `calendar_event_types.reminder_enabled / reminder_minutes_before /
reminder_template_name` e `calendar_appointments.reminder_sent_at` desde a 0177, e a tela de
marcar avisa "Sem lembrete automático — fulano pediu para não receber mensagens". Mas **nada lê
essas colunas e nenhum cron envia** (medido em 2026-10-23: zero leitores fora de
`database.types.ts`). A ferramenta de remarcar ainda diz à IA que "o lembrete é refeito sozinho".
Resultado: o produto promete um aviso que nunca sai — e falta de paciente é o prejuízo número um
de uma clínica.

## O que já existe e este desenho reaproveita

- Envio de modelo aprovado pelo mesmo `sendMessageHandler` que a IA e a tela usam (inclui o
  bloqueio de contato `is_blocked`).
- A janela de 24h derivada de `conversations.last_inbound_at` (`lib/channels/janela.ts`) — a
  pergunta "preciso de modelo?" é de capacidade do canal, nunca de nome de provider.
- O espelho `meta_templates` e o contrato de slots (`deriveTemplateContract`, `slotKey`,
  `renderTemplateBody`, `conferirDefinicao`).
- A janela de cortesia (`janelaDeEnvioAberta`, `PACING_DEFAULTS`: 7h–22h no fuso do tenant).
- O padrão de cron do repo: rota em `app/api/v1/cron/`, linha em `docker/scheduler/entrypoint.sh`,
  Bearer `INTERNAL_SECRET`, auditoria só quando houve efeito.

## Decisões

1. **Cron próprio, a cada 5 min** (`appointment-reminders`), e não `cron_jobs kind=at`. O motor de
   agente foi feito para turnos de IA; o lembrete é determinístico. Um relógio simples, idempotente
   e visível é mais fácil de provar.
2. **Estado no próprio compromisso** (`reminder_state`: `pending | sent | skipped | failed`, mais
   `reminder_detail`, `reminder_attempts`, `reminder_message_id`, `reminder_armed_at`). Uma tabela
   de lembretes múltiplos (D-1 e H-2) fica para quando houver o segundo lembrete — não antes.
3. **Remarcar rearma sozinho: trigger no banco.** Mudou `starts_at` ⇒ volta a `pending`, zera
   tentativas e carimbo. Lembrar de zerar no handler é a classe de bug que a 0177 já descreveu
   ("remarcação ou reprocesso não avisarem duas vezes"); o Google sync também altera horário.
4. **Quando NÃO envia (terminal, `skipped`):** compromisso a menos de 60 min; passou mais de 6 h
   do momento devido; marcado/remarcado **depois** do momento devido (`reminder_armed_at >=
   due_at` — ninguém precisa ser lembrado seis segundos depois de marcar); contato bloqueado ou
   anonimizado. Cancelado/realizado nunca entra na seleção.
5. **Quando ESPERA (continua `pending`):** fora da janela de cortesia; canal fora do ar; janela de
   24h fechada **e** tipo sem modelo configurado (aqui avisa a equipe, uma vez, na caixa de
   alertas — falha de configuração nunca é um `return` mudo).
6. **Forma do envio, por capacidade do canal:** canal sem restrição de janela ⇒ texto; canal com
   janela ⇒ modelo aprovado (obrigatório se a janela fechou; preferido mesmo com a janela aberta,
   por ser o texto aprovado e ter os botões de resposta rápida). Texto padrão em pt-BR quando não
   há modelo e o canal aceita texto livre.
7. **Preenchimento do modelo sem tela de mapeamento:** nomes de variável conhecidos
   (`nome`, `data`, `hora`, `servico`, `profissional`, `local`, `clinica`) ou, em modelo
   posicional, a ordem fixa `1=nome 2=data 3=hora 4=servico 5=profissional 6=local`. Slot fora
   disso, ou variável em cabeçalho/botão, ⇒ modelo **recusado ao salvar** o tipo e, se escapar,
   `failed` com o nome do slot.
8. **Idempotência de dois níveis:** a reivindicação (`reminder_attempts` otimista) impede dois
   ticks simultâneos; a chave `lembrete:<compromisso>:<armed_at>` em `messages.metadata` impede
   reenvio depois de queda entre enviar e carimbar.
9. **Falha é visível:** após 3 tentativas ⇒ `failed` + item na caixa de alertas do agente
   (`appointment_reminder_failed`); a mensagem com erro fica na conversa, como qualquer envio.
10. **A IA só promete o que o resultado confirma.** `marcar` e `remarcar` passam a devolver
    `lembrete: { sera_enviado, antecedencia_min?, motivo? }` e a descrição das ferramentas manda
    não prometer aviso que o resultado não confirme.

## Fora do escopo (e por quê)

- Segundo lembrete (D-1 + mesmo dia): precisa de tabela; nasce quando a clínica pedir.
- Confirmação por botão: o botão do modelo chega como mensagem de entrada e a IA/atendente já a
  trata; não há máquina de estados própria.
- Mostrar o estado do lembrete na tela do compromisso: a coluna `reminder_message_id` deixa o
  caminho aberto; a tela é uma entrega seguinte.

## Como provar

Unidade: decisão pura (cada ramo de 4 e 5), mapeamento de variáveis, executor com dublês (modelo
vs texto, idempotência, 3 falhas, alerta uma vez), rota de cron (auth, limite), esquema Zod do
tipo. Banco (`test:db`): trigger de rearme e a função de seleção de devidos, incluindo isolamento
por organização. E2E real: um compromisso a ~24 h de um paciente da conta de teste, cron
chamado de verdade, mensagem aparecendo na conversa.
