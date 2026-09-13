---
impacto: nada_mudou
secao: corrigido
titulo: O convite de equipe recusa nascer sem segredo em produção
---

O token do convite de equipe é assinado com o segredo da instalação
(`INTERNAL_SECRET`). Se o segredo faltasse, o código caía num valor fixo de
desenvolvimento — uma string que está no repositório público, ou seja, um
convite que qualquer pessoa poderia forjar. Na prática isso nunca acontecia
numa instalação normal, porque o sistema já se recusa a subir em produção sem
esse segredo; mas a última linha de defesa não pode depender da primeira.
Agora, em produção, sem segredo, o convite falha alto em vez de sair assinado
com o valor conhecido. Instalações feitas pelo instalador não mudam em nada:
ele sempre gerou o segredo.
