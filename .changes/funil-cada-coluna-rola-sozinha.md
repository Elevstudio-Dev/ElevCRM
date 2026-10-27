---
impacto: nada_mudou
secao: corrigido
titulo: No funil, cada coluna rola sozinha — e arrastar um card até o fim não leva mais a página junto
---

O quadro do funil tinha dois defeitos que apareciam juntos.

**A página ia junto.** Dentro do quadro havia texto escondido (o aviso de "etapa de ganho" e "etapa de
perda" para leitor de tela) e faixas de cards que escapavam do recorte do quadro e esticavam a janela
inteira para o lado. Quem arrastava um card até o fim via a *página* rolar, não o quadro, e sobrava uma
parte vazia. O quadro agora recorta o que é dele e a janela fica parada.

**As colunas desciam todas juntas.** Os cards passavam da borda da coluna e quem rolava era o quadro
inteiro. Agora o quadro ocupa só a altura que sobra na tela, o título e o total de cada coluna ficam
parados em cima, e cada coluna rola a sua própria lista de cards — ver uma etapa comprida não mexe nas
outras. Só a rolagem para os lados continua no quadro.

Um limite que vale saber: durante o arraste a roda e o trackpad **laterais** ficam travados no quadro,
porque a biblioteca de arrastar mede onde cada coluna está uma vez, ao levantar o card, e rolar para o
lado no meio do gesto faz o card achar a coluna errada (medido: o mouse sobre "Em separação", a
biblioteca dizendo "Aguardando pagamento"). Por isso arrastar para uma etapa que está fora da tela
exige rolar o quadro antes de pegar o card; a roda lateral fora do arraste funciona como sempre.
