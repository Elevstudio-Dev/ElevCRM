---
impacto: capacidade_nova
secao: adicionado
titulo: "A secretaria conta a agenda pelo WhatsApp e a IA a leva para o CRM, depois que ela confere"
---

A mensagem de um contato marcado como **Secretaria** (ficha do contato, "Papel na equipe") deixa de cair no vazio e passa a ser tratada por uma conversa própria, separada do agente de vendas, que nunca atende a equipe. A secretaria escreve como a agenda está ("terça 14h Maria, 15h João; quarta fechado"), a IA lê o texto e devolve um resumo para conferir ("Entendi assim: ter 18/11: 14h Maria · 15h João…"). A agenda do CRM só muda quando ela responde **sim**; se ela corrigir, a IA relê e manda um resumo novo; se houver qualquer dúvida (hora sem dia, nome sem horário, dia fechado e marcado ao mesmo tempo), a IA pergunta em vez de adivinhar.

Salvaguardas: só um "sim" inequívoco confirma ("sim, mas a Ana é às 15h" é uma correção, não uma confirmação); um resumo esperando há mais de 12 horas não vale mais; datas relativas ("amanhã", "quinta") são resolvidas com o relógio e o fuso da agenda, e a leitura recusa dias que já passaram; todas as respostas à secretaria são texto fixo e saem pela mesma cadeia de proteções de qualquer mensagem, que só libera o contato da equipe para esse tipo de mensagem. Nada muda para quem não ligar a agenda da secretaria (`settings.secretaria.ativa`, desligada por padrão).

A mensagem de quem tem papel de Marketing continua sem resposta nesta versão. As perguntas diárias à secretaria e a reserva de horário com confirmação chegam nas próximas versões.
