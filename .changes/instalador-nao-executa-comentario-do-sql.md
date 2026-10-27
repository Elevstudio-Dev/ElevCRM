---
impacto: nada_mudou
secao: corrigido
titulo: O instalador deixava de criar o primeiro administrador num Ubuntu com o comando locale — e a instalação por colagem agora avisa da chave colada em duplicata
---

Numa instalação nova, o `install.sh` aplicava o schema e
**morria ao criar o primeiro administrador**, com `"language" is not a known variable`.
O trecho que cria o dono
monta o SQL com um bloco de texto sem aspas, e o bash executa qualquer coisa entre
crases dentro dele — até em comentário. Um comentário novo escrevia `locale` entre
crases: o bash rodou o comando `locale` e colou a saída dele (`LANG=…`, `LANGUAGE=…`)
no meio do SQL. Acontecia em todo servidor com o comando `locale` (Ubuntu comum).

O comentário perdeu as crases, e a suíte do kit ganhou um guarda que reprova crase
sem escape em qualquer bloco de texto sem aspas dos scripts de instalação.

Quem já tentou instalar e parou nesse ponto: o schema já foi aplicado; atualize o kit
e rode o `install.sh` de novo (ele é idempotente e reaproveita o `.env`).

Também no `instalar-remoto.sh`: o campo de chave não mostra o que você cola, e colar
a mesma chave várias vezes por engano a mandava errada (o Supabase respondia 401 como
se a chave não existisse). Agora ele mostra quantos caracteres recebeu e recusa um
valor que é o mesmo trecho repetido.
