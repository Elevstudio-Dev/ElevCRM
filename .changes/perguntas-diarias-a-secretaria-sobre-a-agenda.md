---
impacto: capacidade_nova
secao: adicionado
titulo: "A IA pergunta à secretaria, três vezes por dia, como está a agenda"
---

Com a agenda da secretaria ligada (`settings.secretaria.ativa`), a IA passa a **perguntar** à secretaria como está a agenda nos horários combinados — por padrão 08:30, 14:00 e 18:15, de segunda a sexta, no fuso da agenda (todos configuráveis pelo CRM em `settings.secretaria.perguntas` e `.dias`). A pergunta é um texto fixo, com o cumprimento do período e um exemplo de como contar a agenda, e vai pelo WhatsApp da clínica pela mesma cadeia de proteções de qualquer mensagem.

Se ela não responde em 30 minutos, a IA **lembra uma vez**; se continua sem responder, o administrador recebe um aviso na **Central de avisos** ("A secretaria não respondeu à pergunta da agenda das 14:00"), com o efeito explicado: enquanto a agenda não for conferida, a IA deixa de oferecer horários aos pacientes. Se a secretaria ainda não tem nenhuma conversa com o número da clínica, o aviso diz exatamente isso e o que fazer.

Salvaguardas: a mesma pergunta nunca sai duas vezes (nem com duas instâncias do agendador rodando juntas); se a agenda acabou de ser conferida, a pergunta é dispensada em vez de repetida; pergunta que ficou esperando na fila mais de duas horas (serviço parado) não é enviada depois — "bom dia" às 15h seria fora de propósito; o lembrete de uma pergunta que ela já respondeu não sai. O número de mensagens à secretaria não conta no limite diário do número da clínica.

Nada muda para quem não ligar a agenda da secretaria. A reserva de horário com confirmação dela chega na próxima versão.
