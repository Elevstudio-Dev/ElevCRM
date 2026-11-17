---
impacto: capacidade_nova
secao: adicionado
titulo: "Fila de follow-up com intervalo entre pacientes e limite por dia"
---

O follow-up por silêncio inscrevia **todos** os pacientes parados de uma vez, e o único freio era o ritmo de envio do canal. Agora o fluxo pode ter um **ritmo de entrada**: um paciente por vez, com um intervalo entre um e outro (por exemplo, de 3 a 9 minutos) e um limite de inscrições a cada 24 horas (por exemplo, 25). Quem está parado há mais tempo entra primeiro.

Na aba **Fila** de Follow-ups aparece a seção **Próximos a entrar na fila**: a lista de quem vem a seguir, na ordem, com a hora prevista de cada um e quantos já entraram nas últimas 24 horas contra o limite. A hora é uma previsão: quem responder antes sai da lista e os seguintes adiantam.

O ritmo é opcional e fica na configuração do gatilho de silêncio (`params.ritmo` com `min_minutos`, `max_minutos` e `limite_por_dia`). Fluxos sem ritmo continuam se comportando como antes.
