---
impacto: nada_mudou
secao: corrigido
titulo: Mensagem enviada a um grupo não aparece mais como "Falhou" quando chegou
---
Na versão 1.24.0, a mensagem enviada a um grupo de WhatsApp passou a aparecer como **"Falhou"** mesmo chegando ao
grupo. O WhatsApp (via WAHA) devolve um aviso de erro (`ack -1`) para mensagens de grupo que não significa falha:
na medição feita na VPS, nenhuma mensagem de grupo recebeu confirmação de entrega ou leitura, e todas que foram
conferidas no celular tinham chegado.

Agora, em **grupo**, esse aviso deixa de marcar falha e de abrir alerta: a mensagem fica como **enviada** (um tique).
Em conversa 1:1 nada mudou: o erro continua aparecendo como falha, e a entrega e a leitura seguem mostrando os dois
tiques cinza e azul.

Limite: em grupo o WhatsApp não informa, mensagem a mensagem, quem recebeu ou leu — por isso o tique em grupo fica em
"enviada". As mensagens de grupo que já estavam marcadas como "Falhou" antes desta correção continuam assim até serem
corrigidas à parte.
