---
impacto: capacidade_nova
secao: adicionado
titulo: O áudio do cliente vira texto na conversa — e o agente passa a ouvir também com a chave da OpenRouter
---

Dois pedaços do mesmo problema: o sistema transcrevia áudio, mas quem atendia não via o texto, e quem
usava a OpenRouter não tinha transcrição nenhuma.

**A atendente lê o áudio sem ouvir.** Embaixo de cada áudio que o cliente manda aparece **Ver texto**.
Um clique abre a transcrição (dá para selecionar e copiar); outro fecha. Enquanto o texto não fica
pronto, a tela diz "Transcrevendo…", e o texto aparece sozinho, sem recarregar a página. Quando não dá
para transcrever, ou o áudio não tem fala, a tela diz isso com todas as letras — o texto interno que o
agente recebe nesses casos nunca aparece como se fosse o que o cliente falou. O áudio que a própria
atendente grava não ganha texto: ela sabe o que disse.

**O agente ouve sem uma chave OpenAI à parte.** Até aqui a transcrição só funcionava com uma chave da
OpenAI, mesmo que a IA de conversa fosse outra. Numa instalação que escolheu a **OpenRouter** no
instalador, o áudio ficava sem transcrição e o agente respondia como se não o tivesse recebido. Agora, sem
chave OpenAI, o áudio é transcrito pela OpenRouter com a mesma chave que já atende a conversa (o mesmo
Whisper). Quem já tem chave OpenAI continua exatamente como estava: nenhum áudio muda de caminho. Com
Anthropic ou Google como IA de conversa ainda é preciso uma chave da OpenAI ou da OpenRouter — o Claude
não ouve áudio —, e a tela "Agente de IA → Provedores" passou a dizer isso corretamente (antes prometia
um serviço rodando na própria máquina, que o sistema nunca aceitou).

Nada para fazer ao atualizar. O texto aparece nos áudios que chegarem a partir daí; áudios antigos, que
nunca foram transcritos, seguem sem texto.
