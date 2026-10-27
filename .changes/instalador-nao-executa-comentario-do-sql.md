---
impacto: nada_mudou
secao: corrigido
titulo: A instalação num servidor novo terminava pela metade — dois defeitos do instalador, achados na primeira instalação real
---

Dois defeitos faziam o `install.sh` parar numa VPS recém-criada (Ubuntu 24.04), cada um
num ponto diferente, e os dois aparecem só num servidor novo.

**O primeiro administrador não era criado.** O instalador aplicava o schema e morria
com `"language" is not a known variable`. O trecho que cria o dono monta o SQL com um
bloco de texto sem aspas, e o bash executa qualquer coisa entre crases dentro dele,
até em comentário. Um comentário escrevia `locale` entre crases: o bash rodou o comando
`locale` e colou a saída dele (`LANG=…`, `LANGUAGE=…`) no meio do SQL. A suíte do kit
ganhou um guarda que reprova crase sem escape em qualquer bloco de texto sem aspas dos
scripts de instalação.

**As automações paravam na primeira.** Numa conta que ainda não tem crontab nenhum (todo
servidor novo), o `crontab -l` sai com erro, e isso derrubava o instalador logo depois de
gravar a primeira linha: o CRM subia, mas o agente de atualização, o monitor e os backups
nunca eram ligados — só aparecia o painel "a instalação parou". A suíte não via porque
os cenários só olhavam o que era escrito antes. Agora há um teste que exige chegar ao fim
numa conta sem crontab, e que rodar de novo não duplica nenhuma linha.

Quem já tentou instalar e parou num desses pontos: atualize o kit e rode o `install.sh`
de novo. Ele é idempotente e reaproveita o `.env` (o schema já aplicado não é refeito).

Também no `instalar-remoto.sh`: o campo de chave não mostra o que você cola, e colar a
mesma chave várias vezes por engano a mandava errada (o Supabase respondia 401 como se
ela não existisse). Agora ele mostra quantos caracteres recebeu e recusa um valor que é
o mesmo trecho repetido.
