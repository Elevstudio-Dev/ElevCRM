---
impacto: nada_mudou
secao: corrigido
titulo: Mensagem que o WhatsApp recusa (como em grupos) agora aparece como falha na hora, com o motivo certo — e o tique azul não volta para trás
---

Algumas mensagens enviadas pelo atendente a um **grupo** de WhatsApp ficavam com o relógio girando por 5 minutos e depois
apareciam como "Falhou" com o texto "Envio não confirmado em 5 min". Na verdade o WhatsApp tinha respondido na hora com um
erro; o CRM é que não sabia ler essa resposta e deixava a mensagem "enviando" até o relógio de segurança marcar a falha,
escondendo quem tinha recusado o envio.

Agora, quando o WhatsApp devolve esse erro, a mensagem vira **"Falhou"** na hora. Ao passar o mouse, a bolha explica: o
WhatsApp não confirmou o envio e vale conferir no celular se o cliente recebeu. A Central de avisos recebe o alerta de
"Uma resposta não chegou ao cliente" (um por conversa, para um grupo não encher a lista). Nada é reenviado sozinho: se o
cliente não recebeu, é só enviar de novo.

Junto veio uma proteção: o aviso de entrega e de leitura nunca mais faz uma mensagem andar para trás. Se um aviso antigo
chegasse atrasado, uma mensagem já lida podia voltar a aparecer como "enviada" e o tique azul sumia. Agora o estado só
avança (enviada, entregue, lida), e uma mensagem já entregue ou lida nunca vira falha por causa de um aviso tardio.

Ainda não sabemos por que o WhatsApp recusa mensagens de grupo com mais frequência do que as de conversa individual; esta
correção só garante que o CRM conte a verdade quando isso acontece.
