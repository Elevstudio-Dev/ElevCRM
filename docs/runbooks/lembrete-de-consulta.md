# Lembrete de consulta por WhatsApp — ligar, testar e diagnosticar

> Desenho e decisões: [`docs/superpowers/specs/2026-10-23-lembrete-de-consulta-design.md`](../superpowers/specs/2026-10-23-lembrete-de-consulta-design.md).
> Código: `lib/agenda/lembrete/`, rota `app/api/v1/cron/appointment-reminders`, migration 0217.

## O que o lembrete faz

A cada 5 minutos o contêiner `scheduler` chama o cron `appointment-reminders`. Ele procura
compromissos vivos (`pending` ou `confirmed`) cujo **momento de avisar** já chegou
(`início − antecedência do tipo`) e manda **uma** mensagem ao paciente.

O lembrete **nasce desligado** em todo tipo de atendimento (migration 0194): enviar mensagem é
irreversível, e quem liga é a pessoa que vê a tela.

### Quando NÃO sai (e fica escrito no compromisso)

| `reminder_state` | `reminder_detail` | Significa |
|---|---|---|
| `skipped` | `blocked` | o contato pediu para não receber mensagens (ou foi anonimizado) |
| `skipped` | `booked_inside_horizon` | o horário foi marcado/remarcado **depois** do momento do aviso — o paciente acabou de combinar |
| `skipped` | `late` | faltava menos de 1 h, a consulta já começou, ou passaram mais de 6 h do momento devido |
| `failed` | `send_failed:<código>` | três tentativas recusadas pelo canal; **a equipe é avisada na Central** |
| `pending` | `no_template` / `no_template:<nome>:<situação>` | canal oficial, janela de 24 h fechada e o tipo não tem modelo aprovado — **a equipe é avisada na Central**; sai sozinho quando o modelo for consertado, se ainda der tempo |
| `pending` | `template_slot:<variável>` | o modelo usa uma variável que o lembrete não sabe preencher |
| `pending` | `channel_down` | o número está desconectado agora; tenta de novo a cada tick |
| `pending` | `outside_courtesy_hours` | fora das 7h–22h no fuso do compromisso; espera abrir |

**Remarcar rearma** (trigger no banco): volta a `pending`, zera tentativas e o carimbo.

## Ligar, passo a passo

1. **Crie o modelo** em *Conexões → Oficial → Templates* (só o canal oficial da Meta exige;
   com o canal por QR o lembrete sai como texto livre). Categoria **Utilidade**. Texto sugerido:

   ```text
   Olá {{nome}}! Lembrete do seu horário na {{clinica}}: {{servico}}, {{data}} às {{hora}}, com {{profissional}}. Local: {{local}}.
   ```

   Botões de resposta rápida: **Confirmo** e **Preciso remarcar**. A resposta do paciente
   chega como mensagem comum e abre a janela de 24 h — a IA ou o atendente seguem dali.
   Variáveis aceitas: `nome`, `data`, `hora`, `servico`, `profissional`, `local`, `clinica`
   (modelo nomeado) ou, em modelo posicional, `{{1}}` a `{{6}}` nessa ordem
   (nome, data, hora, serviço, profissional, local). **Só no corpo** — variável em cabeçalho ou
   botão é recusada ao salvar.
2. **Espere a aprovação** da Meta (a tela mostra a situação do modelo).
3. *Configurações → Tipos de agendamento → Editar* o tipo (ex.: Avaliação, Retorno, Limpeza):
   marque **Avisar o paciente antes do atendimento**, escolha **Quanto tempo antes** (2 h a 3
   dias) e o **Modelo de mensagem**. Modelo que não serve aparece desabilitado, com o motivo.
4. **Teste antes de liberar:** com `ai_gate = allowlist` no canal, marque um compromisso do
   seu próprio número para daqui a ~25 h (lembrete de 1 dia), espere o tick e confira a
   mensagem na conversa. Marque outro para daqui a 3 h e confirme que **não** sai
   (`booked_inside_horizon`) — é o comportamento certo.

## Diagnosticar

O cron roda no contêiner `scheduler`; sem ele a rota existe e nunca roda sozinha.

```bash
docker compose logs --tail=50 scheduler
```

Estado dos lembretes (substitua a organização):

```sql
select a.id, a.starts_at, a.reminder_state, a.reminder_detail, a.reminder_attempts, a.reminder_sent_at
  from calendar_appointments a
 where a.organization_id = '<org>' and a.starts_at > now() - interval '1 day'
 order by a.starts_at;
```

Alertas abertos na Central (*Avisos*): tipo `appointment_reminder_failed`. Um por tipo de
atendimento quando o problema é de cadastro, um por compromisso quando o canal recusou.

Chamar o cron à mão (o corpo da resposta traz as contagens do tick):

```bash
curl -fsS -H "Authorization: Bearer $INTERNAL_SECRET" http://localhost:3000/api/v1/cron/appointment-reminders
```

## Limites conhecidos

- **Um lembrete por compromisso.** Dois avisos (véspera + mesmo dia) pedem uma tabela própria e
  entram quando a clínica pedir.
- A tela do compromisso ainda **não mostra** o estado do lembrete; a coluna
  `reminder_message_id` deixa o caminho aberto.
- O lembrete só prova que o canal **aceitou** a mensagem. No canal oficial a entrega pode ser
  recusada depois pelo webhook (por exemplo `131047`); a falha aparece na conversa como em
  qualquer envio.
- Paciente que nunca conversou (importado) recebe o aviso abrindo a conversa pelo canal que
  estiver no ar — e, no canal oficial, **só com modelo aprovado** e com consentimento do paciente
  para ser contatado (responsabilidade da clínica; ver a política de opt-in da Meta).
