#!/usr/bin/env bash
# Gate do docker/scheduler/entrypoint.sh — o único artefato executável novo da
# doutrina de packaging, e o que ficou sem cobertura na primeira versão dela.
#
# O que ele guarda, e por que cada coisa:
#
# 1. O SEGREDO SOBREVIVE INTEIRO E LITERAL. O crond executa cada linha do crontab
#    por `/bin/sh -c`, então o valor é REAVALIADO na hora de disparar. A versão
#    anterior interpolava o INTERNAL_SECRET dentro de aspas duplas: um `$` no
#    valor virava expansão de variável (header truncado → todo cron respondendo
#    401 em silêncio) e uma crase virava substituição de comando — execução
#    arbitrária a cada minuto. Aqui o teste monta o header com um `sh` DE VERDADE,
#    como o crond faria, e compara byte a byte.
#
# 2. NENHUMA ROTA SE PERDE. O crontab saiu do `command:` inline do compose e veio
#    para cá; a contagem tem de bater com app/api/v1/cron. (A cerca principal é
#    tests/unit/cron-routes-scheduled.test.ts; esta aqui pega o caso em que o
#    arquivo GERADO diverge da lista escrita, que aquele teste não vê.)
#
# 3. FALHA FECHADA SEM SEGREDO. Sem INTERNAL_SECRET os crons responderiam 401 e
#    nada aconteceria — sem erro, sem log, sem sintoma. O script recusa subir.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ENTRYPOINT="docker/scheduler/entrypoint.sh"
fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check() {
  local nome="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  ✓ %s\n' "$nome"
  else printf '  ✗ %s\n' "$nome"; fail=1; fi
}

# `crond` dublado: o entrypoint termina em `exec crond`, que não existe no macOS
# nem no runner. Sem o dublê o script morreria DEPOIS de escrever o crontab — o
# arquivo estaria certo e o teste falharia por motivo errado.
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/crond"
chmod +x "$TMP/bin/crond"

rodar() { # $1 = valor de INTERNAL_SECRET ("" = ausente)
  local out="$TMP/crontab"
  : > "$out"
  if [ -z "$1" ]; then
    env -u INTERNAL_SECRET PATH="$TMP/bin:$PATH" CRONTAB_PATH="$out" \
      sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
  else
    env INTERNAL_SECRET="$1" PATH="$TMP/bin:$PATH" CRONTAB_PATH="$out" \
      sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
  fi
  echo $?
}

echo "scheduler: o crontab é gerado com todas as rotas"
RC="$(rodar 'segredo-simples')"
check "o entrypoint termina com sucesso" test "$RC" -eq 0
ROTAS_CODIGO="$(find app/api/v1/cron -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
ROTAS_CRONTAB="$(grep -oE 'api/v1/cron/[a-z0-9-]+' "$TMP/crontab" | sort -u | wc -l | tr -d ' ')"
check "as $ROTAS_CODIGO rotas do código estão no crontab (achei $ROTAS_CRONTAB)" \
  test "$ROTAS_CODIGO" -eq "$ROTAS_CRONTAB"
check "uma linha por cron, nenhuma vazia" \
  test "$(grep -c . "$TMP/crontab")" -eq "$(wc -l < "$TMP/crontab" | tr -d ' ')"

echo "scheduler: o segredo atravessa o sh do crond intacto"
# Os três caracteres que quebram interpolação ingênua, de uma vez só.
HOSTIL='seg`whoami`redo$HOME-com'\''aspa-e-"aspas"'
RC="$(rodar "$HOSTIL")"
check "gerou o crontab mesmo com segredo cheio de metacaractere" test "$RC" -eq 0

# A medição que importa: pegar a PRIMEIRA linha, tirar o prefixo de agendamento,
# e mandar um `sh` de verdade avaliá-la — exatamente o que o crond faz. O `curl`
# é dublado por um script que imprime o header que recebeu.
printf '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-H" ] && { printf "%%s" "$2"; exit 0; }; shift; done\nexit 1\n' > "$TMP/bin/curl"
chmod +x "$TMP/bin/curl"
LINHA="$(head -1 "$TMP/crontab")"
COMANDO="${LINHA#* * * * * }"                 # tira o agendamento de 5 campos
COMANDO="${COMANDO%% >/dev/null*}"            # tira a redireção
RECEBIDO="$(PATH="$TMP/bin:$PATH" sh -c "$COMANDO")"
ESPERADO="Authorization: Bearer ${HOSTIL}"
if [ "$RECEBIDO" = "$ESPERADO" ]; then
  printf '  ✓ o header chega ao curl byte a byte igual ao segredo do .env\n'
else
  printf '  ✗ o segredo foi corrompido pelo sh do crond\n'
  printf '     esperado: %s\n' "$ESPERADO"
  printf '     recebido: %s\n' "$RECEBIDO"
  fail=1
fi
# Controle negativo do próprio instrumento: se a crase tivesse sido executada, o
# crontab conteria a saída de `whoami` no lugar dela, não o texto literal.
check "a crase NÃO foi executada (está literal no arquivo)" \
  grep -q 'whoami' "$TMP/crontab"

echo "scheduler: cron que falha deixa rastro legível, sem vazar o segredo"
# A linha INTEIRA, com a redireção, é executada por um `sh` de verdade — como o crond. O `curl` é dublado para
# falhar como o de verdade falha (`-fsS`: mensagem no stderr, código 22). O destino do log é um arquivo, no lugar
# de /proc/1/fd/2, pela injeção CRON_LOG_PATH.
SEGREDO_DO_TESTE='segredo-que-nao-pode-vazar-9f3a'
: > "$TMP/crontab"
env INTERNAL_SECRET="$SEGREDO_DO_TESTE" PATH="$TMP/bin:$PATH" CRONTAB_PATH="$TMP/crontab" CRON_LOG_PATH="$TMP/cron.log" \
  sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
check "cada linha do crontab leva o rastro de falha" \
  test "$(grep -c 'falhou (curl saiu com' "$TMP/crontab")" -eq "$(grep -c . "$TMP/crontab")"
check "o rastro vai para o stderr do contêiner (o que o Docker guarda com rotação)" \
  grep -q '/proc/1/fd/2' "$ENTRYPOINT"
check "o corpo da resposta continua descartado (stdout em /dev/null)" \
  grep -q '>/dev/null 2>>' "$TMP/crontab"

LINHA_CRU="$(grep 'agent-dispatcher' "$TMP/crontab" | head -1)"
LINHA_CMD="${LINHA_CRU#* * * * * }"
printf '#!/bin/sh\necho "curl: (22) The requested URL returned error: 500" >&2\nexit 22\n' > "$TMP/bin/curl"
chmod +x "$TMP/bin/curl"
: > "$TMP/cron.log"
PATH="$TMP/bin:$PATH" sh -c "$LINHA_CMD"
check "curl falhando: o log nomeia a rota que falhou" grep -q 'cron api/v1/cron/agent-dispatcher falhou' "$TMP/cron.log"
check "  e o código de saída do curl" grep -q 'curl saiu com 22' "$TMP/cron.log"
check "  e a causa que o curl deu" grep -q 'returned error: 500' "$TMP/cron.log"
check "  e NADA do segredo chegou ao log" test "$(grep -c "$SEGREDO_DO_TESTE" "$TMP/cron.log")" -eq 0

printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/curl"
: > "$TMP/cron.log"
PATH="$TMP/bin:$PATH" sh -c "$LINHA_CMD"
check "curl OK: o log fica vazio (só o que importa é escrito)" test ! -s "$TMP/cron.log"

# Rota com query string (`?limit=50`): o nome no rastro é o da rota, sem o parâmetro.
LINHA_Q="$(grep 'storage-redaction' "$TMP/crontab" | head -1)"
check "rota com query string: o rastro nomeia só a rota" grep -q 'cron api/v1/cron/storage-redaction falhou' <<<"$LINHA_Q"

echo "scheduler: sem INTERNAL_SECRET, recusa em vez de subir mudo"
RC="$(rodar '')"
check "sai com código 1" test "$RC" -eq 1
check "explica o motivo na saída" grep -q "INTERNAL_SECRET" "$TMP/saida"
check "não deixou crontab pela metade" test ! -s "$TMP/crontab"

if [ "$fail" -eq 0 ]; then
  echo "OK — todas as provas passaram."
else
  echo "FALHOU."
fi
exit "$fail"
