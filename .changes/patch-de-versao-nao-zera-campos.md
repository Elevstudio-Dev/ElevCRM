---
impacto: nada_mudou
secao: corrigido
titulo: "Salvar só o prompt de um rascunho do agente não apaga mais as ferramentas"
---

Ao editar um rascunho de versão do agente pela API enviando só alguns campos (por exemplo, só o prompt), o sistema preenchia os campos que não vieram com os valores padrão e gravava por cima: as **ferramentas** voltavam para nenhuma, o limite de passos, o follow-up e as palavras de transferência para humano também. Agora o PATCH muda **apenas o que foi enviado**; o resto do rascunho fica como estava. Enviar um campo vazio de propósito (por exemplo, zero ferramentas) continua funcionando. Se nenhum dos campos enviados puder ser editado por essa rota, ela responde com erro claro em vez de falha interna.
