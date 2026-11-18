---
impacto: nada_mudou
secao: corrigido
titulo: "Fila de follow-up com ritmo: corrige consulta que falhava em produção"
---

Na 1.34.0, a consulta das inscrições recentes (que alimenta o intervalo entre pacientes, o limite por dia e a seção "Próximos a entrar na fila") pedia ao banco uma coluna de data que a tabela não tem. Com o ritmo ligado em um fluxo, a varredura de silêncio falhava a cada minuto e a seção "Próximos a entrar" respondia com erro. Fluxos sem ritmo não eram afetados. Agora a consulta usa a coluna certa (`started_at`) e há testes contra o banco real que reprovam se o nome estiver errado. A rota também passa a registrar a causa do erro em vez de responder em silêncio.
