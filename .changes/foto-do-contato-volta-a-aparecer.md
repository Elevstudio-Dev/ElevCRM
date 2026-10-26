---
impacto: nada_mudou
secao: corrigido
titulo: A foto do contato volta a aparecer — na lista de conversas, no cabeçalho, na tabela de contatos e nos grupos
---

A foto não aparecia por três motivos independentes, e os três foram corrigidos.

**A tela.** Cada lista montava o avatar por conta própria, e só a ficha do
contato sabia pedir a imagem. Agora a lista de conversas, o cabeçalho e a
tabela de contatos usam o mesmo componente, então as três mostram a foto (ou as
iniciais, quando não há) do mesmo jeito.

**O endereço novo do WhatsApp.** O WhatsApp passou a endereçar parte dos
contatos por um identificador opaco em vez do número, e para esses a foto pedida
pelo número voltava vazia — o sistema concluía "esta pessoa não tem foto" e
desistia por sete dias. A foto agora é pedida pela identidade que o WhatsApp usa
hoje. Numa instalação real, 28 dos 30 contatos que estavam sem foto passaram a
ter.

**Os grupos.** A varredura de fotos não enxergava grupo nenhum (grupo não tem o
identificador de pessoa). Numa instalação real, 8 dos 12 grupos ganharam foto
na primeira passada; os outros 4 não têm imagem definida.

As fotos aparecem em até alguns minutos depois da atualização: o relógio que as
busca roda a cada 10 minutos.
