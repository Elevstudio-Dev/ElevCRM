---
impacto: nada_mudou
secao: corrigido
titulo: Contatos que chegam de anúncio da Meta passam a ser reconhecidos, e o áudio volta a ser transcrito
---
Dois defeitos que apareciam no atendimento:

- **Campanha da Meta não era reconhecida.** Quando alguém clicava num anúncio "Clique para o WhatsApp" e mandava a
  primeira mensagem, o contato nascia sem origem. O sistema procurava o dado do anúncio por um nome que o WhatsApp não usa;
  agora lê o formato real, em qualquer tipo de mensagem (texto, foto, áudio, documento). Posts orgânicos compartilhados
  continuam não contando como anúncio.
- **Áudio não era transcrito (e a IA não entendia o que o cliente disse)** em organizações cujo provedor de conversa não
  tem chave cadastrada mas que têm uma chave da OpenAI. A transcrição agora procura a própria chave (OpenAI, depois
  OpenRouter) sem depender da chave de conversa. Fotos nessa mesma situação viram o aviso de "não consegui ler a imagem"
  na Central, em vez de falharem em silêncio depois de cinco tentativas.
