---
impacto: capacidade_nova
secao: adicionado
titulo: "Reserva de horário que a secretaria confirma pelo WhatsApp"
---

Com a agenda da secretaria ligada, a IA deixa de marcar a consulta sozinha. Quando o paciente escolhe um horário, a IA pede o **nome completo** dele, **segura o horário por 15 minutos** (nenhum outro paciente o recebe como livre) e pergunta à secretaria, pelo WhatsApp: "Esse horário está livre? Responda SIM ou NÃO".

- **"Sim"**: o sistema marca o compromisso de verdade e avisa o paciente com uma mensagem fixa de confirmação. A secretaria recebe um aviso de que ficou anotado.
- **"Não"**: o paciente recebe uma mensagem fixa com até dois horários livres parecidos (um no mesmo dia, outro em outro dia), escolhidos pelo servidor. O horário recusado não é oferecido de novo até a agenda ser conferida outra vez.
- **Sem resposta em 15 minutos**: o horário volta a ficar livre, o paciente recebe horários parecidos e a equipe é avisada na Central de avisos. Se não houver horário parecido, a equipe é chamada para combinar à mão.

Só um "sim" ou "não" seco vale; "sim, mas só às 15h" não marca nada. A secretaria só recebe **uma pergunta de reserva por vez**, para o "sim" ter um único significado. Se o paciente não puder ser avisado (janela fechada, sem conversa), a equipe recebe o texto na Central de avisos em vez de o paciente ficar no escuro. Nada muda para organizações que não ligaram a agenda da secretaria: a IA continua marcando direto.
