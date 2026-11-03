---
impacto: capacidade_nova
secao: adicionado
titulo: Marcar alguém com @ — no chat da equipe, na nota interna e nos grupos de WhatsApp
---
Ao digitar **@** num campo de escrever, abre a lista de pessoas que dá para marcar — como no WhatsApp. Dá para filtrar
digitando o começo do nome, escolher com as setas e **Enter** (ou **Tab**), ou tocar numa linha; **Esc** fecha. O nome
escolhido fica em destaque no texto, e a pessoa marcada é avisada.

- **Chat da equipe**: a lista traz quem está naquele canal (o Geral, ou o setor). A pessoa marcada vê "fulano marcou
  você" no aviso, e o **@todos** avisa o canal inteiro. Na conversa direta (só duas pessoas) não há a quem marcar.
- **Nota interna da conversa**: a lista traz só os colegas que **enxergam aquela conversa** — respeitando o setor e o modo
  de visibilidade da organização. Quem não abre a conversa não aparece e não recebe o aviso (antes, citar um nome na nota
  avisava qualquer pessoa da organização que tivesse aquele nome, mesmo sem acesso à conversa). O **@todos** avisa quem
  enxerga a conversa.
- **Grupos de WhatsApp**: ao responder num grupo, a lista traz os **participantes do grupo** (pelo nome que a pessoa usa no
  WhatsApp; quem nunca escreveu no grupo aparece pelo telefone) e o **@todos**. O CRM envia a marcação junto com a
  mensagem, e o WhatsApp avisa o participante no aparelho dele. Na bolha, o CRM continua mostrando o nome.

Duas pessoas com o mesmo nome não se confundem: a marcação guarda **quem** foi escolhido, não só o texto. Se você apagar
o nome do texto antes de enviar, a marcação some junto.

Limites: a marcação em grupo foi feita conforme a documentação do WhatsApp conectado, mas
**ainda não foi conferida num grupo e num celular de verdade**. Na primeira vez, marque alguém de teste e confirme que o
aparelho dele recebe o aviso (vale o mesmo para o @todos e para quem esconde o número). Ela depende de o WhatsApp
conectado responder a lista de participantes — se ele não responder, o **@** simplesmente não abre (a conversa segue
normal). Participantes que escondem o número aparecem como "Participante 123456" até escreverem no grupo. Quando outra
pessoa marca alguém no grupo, o CRM mostra o nome se já o conhece (pelo que a pessoa escreveu no grupo); se não, a
mensagem continua aparecendo com o número no lugar do nome. O **@todos** de uma nota interna não gera o aviso instantâneo
na tela (só o do navegador/celular), porque a nota chega ao navegador de toda a organização.

A atualização aplica sozinha a migração 0222. Nada a fazer.
