---
impacto: nada_mudou
secao: corrigido
titulo: Responder em um grupo volta a funcionar — a conversa do grupo é achada pela chave do grupo
---

O envio para um grupo falhava com "Contato sem telefone para envio WhatsApp".
Medido numa instalação real: **9 grupos tinham duas conversas cada** — uma com a
chave do grupo e quase vazia, outra sem a chave e com a história inteira. O
destino de um grupo só existe na chave dele, e a segunda mensagem de cada grupo
criava uma conversa nova em vez de achar a primeira.

A correção faz a chave do grupo entrar na busca da conversa: a partir desta
versão, as mensagens novas de um grupo vão sempre para a conversa certa, na
entrada e na saída (inclusive o que o dono escreve pelo celular), e importar
grupos de novo não duplica nada. A atualização aplica a mudança de banco
sozinha.

As conversas duplicadas que já existiam **continuam existindo**: esta versão
não mexe em dados. As mensagens novas passam a ir para a conversa que tem a
chave, e a fusão do que ficou para trás é um reparo à parte.
