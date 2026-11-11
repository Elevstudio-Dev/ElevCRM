---
impacto: nada_mudou
secao: corrigido
titulo: "Atualizar uma instalação existente para a 1.28.0 agora cria a coluna das conversas da Meta"
---

A 1.28.0 acrescentou a coluna `conversations` ao gasto da Meta e mudou o retorno da função do relatório de anúncios, mas o arquivo que o `update.sh` reaplica só criava a coluna em instalações novas — quem já tinha a tabela ficava sem ela, e a sincronização da Meta falharia ao gravar. O baseline agora acrescenta a coluna e troca a versão antiga da função. O teste de banco também ganhou uma prova de atualização (`BASELINE_ANTERIOR`), que parte do baseline da versão anterior, como faz o `update.sh`.
