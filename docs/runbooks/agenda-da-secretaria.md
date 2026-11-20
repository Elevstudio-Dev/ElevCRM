# Agenda da secretária — operação

A secretária conta a agenda por WhatsApp; a IA devolve um resumo ("Entendi assim: … Está certo?") e só atualiza a
agenda do CRM quando ela responde **sim**. Enquanto a agenda não é conferida, a IA de vendas não oferece horários e
diz ao paciente que vai confirmar com a recepção. O código está em `lib/bastidor/secretaria/` (o roteiro) e
`lib/agenda/secretaria/` (o que muda na agenda).

## Reprocessar a resposta de uma secretária que não foi aplicada

**Quando usar.** A Central de avisos mostra *"A agenda que a secretária confirmou não foi aplicada"*, ou a
secretária respondeu **sim** a um resumo e a agenda não mudou. O script faz o turno dela rodar de novo para aquela
mesma resposta — pelo caminho de sempre, com as mesmas proteções.

**Antes.** A instalação precisa estar na versão com o conserto (1.34.3 ou mais nova): numa versão anterior o
reprocessamento falha do mesmo jeito. E rode **logo depois de atualizar** — se ela mandar uma mensagem nova antes, o
resumo vencido é descartado e o caminho passa a ser pedir a agenda de novo.

**1. Ache os dois ids.** O aviso da Central aponta para o job que morreu. Na VPS, na pasta do projeto:

```bash
source hostgator-setup-kit/_common.sh && enter_project && psql_run -c \
  "select id as job, organization_id as organizacao, created_at from job_queue
    where kind = 'bastidor_turn' and status = 'dead' order by created_at desc limit 5;"
```

**2. Veja a prévia (não altera nada):**

```bash
bash hostgator-setup-kit/reprocessar-resposta-da-secretaria.sh --organizacao <organizacao> --job <job>
```

Também aceita `--mensagem <id da mensagem do sim>` ou `--relato <id do relato>` no lugar de `--job`. Confira:

- o relato está `lido` e é o resumo certo (data e janela);
- "O turno vai ler 1 mensagem(ns) dela; a última: "Sim"" — se aparecer outra coisa, ela escreveu mais depois do sim;
- a validade foi medida até a hora em que ela respondeu (limite de 12 horas);
- a prévia do que muda na agenda (cria, troca, mantém, cancela, fecha o dia). É aproximada: quem decide é o aplicador.

**3. Enfileire:** o mesmo comando com `--aplicar` (pede confirmação). Ele grava **um** job novo na fila e mais
nada. Em alguns segundos o worker processa, ela recebe "Pronto, agenda atualizada…" e a agenda muda.

**4. Confira** a conversa dela e a agenda. O aviso antigo da Central pode ser resolvido.

**O que o script recusa** (e, recusando, não escreve nada): relato que não está `lido` (já conferido, corrigido ou
descartado); um resumo mais novo dela; resposta dada mais de 12 horas depois do resumo (aí o resumo venceu de
verdade — peça a agenda de novo); resposta nossa ou da equipe depois do sim (o turno não leria o sim); turno dela já na
fila; organização que não é a da mensagem; agenda sem dono configurado.

O SQL do script é `hostgator-setup-kit/reprocessar-resposta-da-secretaria.sql`, provado contra um Postgres de
verdade em `tests/invariants/reprocessar-resposta-da-secretaria.test.ts` (inclusive o job enfileirado aplicando a
agenda pelo handler real).
