---
impacto: nada_mudou
secao: corrigido
titulo: O healthcheck.sh declarava "saudável" um app com o banco fora
---

O diagnóstico do kit procurava `"status":"ok"` no JSON cru da rota de saúde.
`ok` é o vocabulário dos checks individuais, então o do Redis casava e o app
inteiro saía "✓ saudável" mesmo com o banco fora do ar. Agora o diagnóstico lê o
status geral (`healthy`, `degraded` ou `unhealthy`) — o mesmo critério que o
instalador e o atualizador já usavam — e passa a mostrar também o estado do
monitor e dos backups.
