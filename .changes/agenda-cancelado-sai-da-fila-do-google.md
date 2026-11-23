---
impacto: nada_mudou
secao: corrigido
titulo: "Agenda: compromisso cancelado deixa de ser apagado do Google a cada 5 minutos"
---

Quando um compromisso cancelado era apagado do Google Agenda, o CRM não conseguia gravar que a exclusão tinha terminado (a coluna de sequência não aceita vazio) e o erro era ignorado. O compromisso continuava na fila e o pedido de exclusão saía de novo a cada 5 minutos, sem aparecer erro em lugar nenhum. Agora a exclusão é registrada e o compromisso sai da fila. Há testes contra o banco real.
