---
impacto: nada_mudou
secao: corrigido
titulo: Os tiques de uma mensagem enviada a grupo passam a acompanhar o que o WhatsApp mostra
---
Em grupo, a mensagem ficava sempre com um tique só ("enviada"), mesmo quando as pessoas já tinham recebido e lido: o
WhatsApp avisa o CRM disso por um evento separado (recibo de grupo), que o CRM não estava escutando.

Agora o CRM escuta esse evento e a mensagem de grupo anda como no WhatsApp:

- **dois tiques cinza (entregue)**: alguém do grupo recebeu;
- **dois tiques azuis (lida)**: **todos** os outros participantes leram.

Limites: o WhatsApp só entrega esses avisos para quem tem a confirmação de leitura ligada, então quem a desligou nunca
conta como "leu" (a mensagem fica cinza). O WhatsApp também não informa de forma confiável quando a mensagem chegou a
**todos**: por isso "entregue" aparece quando **alguém** recebeu. Se o CRM não conseguir ler a lista de participantes do
grupo, a mensagem nunca fica azul (fica cinza). Mensagens enviadas antes desta versão não ganham os tiques de volta.

A atualização reinicia o conector do WhatsApp (o WAHA) para passar a assinar o evento novo: o WhatsApp reconecta sozinho
em instantes.
