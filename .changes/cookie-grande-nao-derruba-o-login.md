---
impacto: nada_mudou
secao: corrigido
titulo: Cookie grande não derruba mais o login (HTTP 431)
---

Quando o navegador mandava cookies demais junto com a requisição — o CRM num
subdomínio recebe todos os cookies do domínio da empresa (site, analytics,
chat), além do próprio token de sessão —, o servidor recusava antes de o
sistema ver a requisição: tela cinza do navegador com "HTTP ERROR 431", sem
nada no log, e "Tentar de novo" não resolvia. O limite do servidor dobrou
(de 16 KB para 32 KB de cabeçalho), e uma instalação atualizada recebe isso
sem mexer em nada. Se ainda assim acontecer, limpar os cookies do domínio
resolve na hora.
