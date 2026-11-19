---
impacto: nada_mudou
secao: corrigido
titulo: "Follow-up: quem responde sai do fluxo, mesmo no meio de uma espera entre toques"
---

Fluxos de follow-up com "cancelar ao responder" ligado só cancelavam quando o paciente estava no estado "aguardando resposta". Se o fluxo estava parado numa espera entre dois toques (1 a 7 dias, no fluxo de retomada de pacientes), qualquer resposta do paciente acordava a espera e o fluxo mandava o próximo toque na hora. Na clínica, um paciente que respondeu 5 vezes em 2 minutos recebeu 3 toques de follow-up por cima da conversa com a IA. Agora a resposta encerra o fluxo (resultado "respondeu") nos dois casos, e quem não usa "cancelar ao responder" continua como antes. Há testes contra o banco real, incluindo várias respostas seguidas.
