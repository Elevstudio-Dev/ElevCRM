---
impacto: capacidade_nova
secao: adicionado
titulo: O lembrete de consulta sai por WhatsApp — e deixa rastro quando não sai
---

Falta de paciente é o prejuízo número um de uma clínica, e a tela de marcar já
avisava que "fulano não receberá o lembrete" sem nunca mandar lembrete a
ninguém. Agora manda.

**Como ligar.** Em Configurações → Agenda → Tipos de agendamento, cada tipo
ganha o lembrete: ligar, quanto tempo antes (de 2 horas a 3 dias) e qual
modelo de mensagem aprovado usar. Ele nasce **desligado** em todos os tipos —
nada muda para quem não liga.

**O que o sistema decide sozinho.** Só manda no horário de cortesia (das 7h às
22h, no fuso do compromisso). Não manda para quem pediu para não receber
mensagens, nem para quem marcou depois do momento em que o aviso sairia (quem
marca em cima da hora já sabe). Se o compromisso é remarcado, o lembrete é
refeito para o horário novo. Cada compromisso recebe um lembrete só, e o motivo
de não ter saído fica escrito nele.

**Canal oficial da Meta.** Fora da janela de 24 horas o WhatsApp oficial só
aceita modelo aprovado. O lembrete usa o modelo que você escolheu (as variáveis
`nome`, `data`, `hora`, `servico`, `profissional`, `local` e `clinica` são
preenchidas sozinhas); se o tipo está ligado e não há modelo utilizável, a
Central de avisos mostra um aviso por tipo, e não um por paciente.

**Quando falha.** Depois de três tentativas a equipe vê na Central de avisos
"Um lembrete de consulta não chegou ao paciente".

**A IA não promete o que o sistema não cumpre.** Ao marcar ou remarcar, a IA
recebe do sistema se o lembrete será mesmo enviado e só então o promete ao
paciente. O playbook global de agendamento foi atualizado para isso (versão 3),
e a atualização o aplica sozinha.

O passo a passo, os estados de cada lembrete e como diagnosticar estão em
`docs/runbooks/lembrete-de-consulta.md`.
