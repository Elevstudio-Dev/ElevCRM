---
impacto: nada_mudou
secao: novo
titulo: "Follow-up automático: lead de anúncio só entra depois da avaliação"
---

O gatilho de silêncio de um fluxo de follow-up ganhou um parâmetro opcional, `leads_de_anuncio`, com a lista de etapas do funil (pelo identificador da etapa) em que um contato que veio de anúncio passa a poder entrar no follow-up automático. Enquanto o lead de anúncio não chega a uma dessas etapas, o varredor não o inscreve; quem não veio de anúncio segue como sempre. O follow-up agendado por uma pessoa da equipe (botão "Agendar follow-up" e inscrição manual) não passa por essa regra. Sem o parâmetro o comportamento é o de antes, então outras organizações e outros fluxos não mudam. A tela "Próximos a entrar na fila" usa a mesma regra.
