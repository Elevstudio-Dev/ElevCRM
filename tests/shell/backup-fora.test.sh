#!/usr/bin/env bash
# Prova do backup fora da VPS (`hostgator-setup-kit/backup-fora.sh`).
#
#   bash tests/shell/backup-fora.test.sh
#
# ── O que ele guarda ────────────────────────────────────────────────────────
# Um backup tem três maneiras de fingir que existe: (1) rodar e não chegar a lugar
# nenhum, (2) chegar vazio ou truncado, (3) chegar em claro. Cada uma tem teste aqui,
# mais o que protege o backup depois de enviado: a chave de envio que não pode apagar.
#
# O princípio é o do monitor: o marcador `.backup-fora.ok` — em que o monitor.sh
# confia para dizer "o backup está em dia" — só pode nascer depois de ENVIAR e
# CONFERIR. Todo caminho de falha abaixo prova que ele NÃO foi atualizado.
#
# Nada aqui toca a máquina de quem roda: `docker` (inclusive o rclone, que roda em
# contêiner) é um dublê que emula o armazenamento remoto numa pasta temporária, e o
# `age` é um dublê que cifra de mentira mas de forma que o claro NÃO apareça no
# resultado — é assim que o teste enxerga um vazamento.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
tem()    { printf '%s' "$1" | grep -qF -- "$2"; }
naotem() { ! printf '%s' "$1" | grep -qF -- "$2"; }

# ── Dublês ───────────────────────────────────────────────────────────────────
mkdir -p "$WORK/bin"

# age: exige ao menos um -r; anota os destinatários; "cifra" em base64 com cabeçalho,
# para que o texto em claro NÃO sobreviva no arquivo (senão o teste de vazamento
# jamais enxergaria nada).
cat > "$WORK/bin/age" <<'STUB'
#!/usr/bin/env bash
destinatarios=0
while [ $# -gt 0 ]; do
  case "$1" in -r) echo "age -r $2" >> "$STUB_LOG"; destinatarios=$((destinatarios + 1)); shift ;; esac
  shift
done
[ "$destinatarios" -gt 0 ] || { echo "age: sem destinatário" >&2; exit 1; }
echo "AGE-STUB v1"
base64
STUB

# docker: emula volume, pg_dump, tar e o rclone (contra uma pasta que faz de bucket).
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
remoto() { printf '%s/%s' "$FAKE_REMOTE" "${1#*:}"; }
case "${1:-}" in
  volume) [ "${STUB_VOLUME_EXISTE:-0}" = 1 ]; exit $? ;;
  run) ;;
  *) exit 0 ;;
esac
shift
mount_dados=""; sub=""; resto=()
achou_imagem=0
for a in "$@"; do
  case "$a" in *:/dados:ro) mount_dados="${a%%:/dados:ro}" ;; esac
  if [ "$achou_imagem" = 1 ] && [ -z "$sub" ]; then sub="$a"; continue; fi
  [ "$achou_imagem" = 1 ] && resto+=("$a")
  case "$a" in rclone/rclone:*) achou_imagem=1 ;; esac
done
if [ "$achou_imagem" = 0 ]; then
  case " $* " in
    *pg_dump*) [ "${STUB_DUMP_RC:-0}" -eq 0 ] || exit "$STUB_DUMP_RC"; printf '%s' "${STUB_DUMP-}"; exit 0 ;;
    *" tar cz "*) printf '%s' "${STUB_WAHA:-dados-do-waha}"; exit 0 ;;
  esac
  exit 0
fi
case "$sub" in
  lsf)        exit "${STUB_LSF_RC:-0}" ;;
  copy)       [ "${STUB_COPY_RC:-0}" -eq 0 ] || exit "$STUB_COPY_RC"
              dest="$(remoto "${resto[1]}")"; mkdir -p "$dest"; cp -r "$mount_dados"/. "$dest"/ ;;
  check)      [ "${STUB_CHECK_RC:-0}" -eq 0 ] || exit "$STUB_CHECK_RC"
              dest="$(remoto "${resto[1]}")"
              for f in "$mount_dados"/*; do cmp -s "$f" "$dest/$(basename "$f")" || exit 1; done ;;
  deletefile) if [ "${STUB_DELETE_RC:-1}" -eq 0 ]; then rm -f "$(remoto "${resto[0]}")"; exit 0; fi; exit 1 ;;
esac
exit 0
STUB
chmod +x "$WORK"/bin/*
PATH="$WORK/bin:$PATH"

# 58 caracteres depois de "age1": o formato de uma chave pública age de verdade.
CHAVE1="age1$(printf 'q%.0s' $(seq 1 58))"
CHAVE2="age1$(printf 'p%.0s' $(seq 1 58))"
DUMP_BOM="$(seq 1 4000 | sed 's/^/INSERT INTO t VALUES (/;s/$/, x);/')"

# ── Cada caso nasce de um projeto limpo ──────────────────────────────────────
novo_projeto() {  # novo_projeto <nome> [linhas extras do .env...]
  P="$WORK/$1"; shift
  LOG="$P/stub.log"; export FAKE_REMOTE="$P/remoto"
  mkdir -p "$P" "$FAKE_REMOTE"
  : > "$P/docker-compose.prod.yml"; : > "$LOG"
  {
    echo "SUPABASE_DB_URL=postgresql://postgres.x:SENHA-DO-BANCO-9z@host:5432/postgres"
    echo "BACKUP_FORA_DESTINO=fora:bucket/elevcrm"
    echo "BACKUP_AGE_RECIPIENT=$CHAVE1"
    echo "RCLONE_CONFIG_FORA_TYPE=b2"
    echo "RCLONE_CONFIG_FORA_ACCOUNT=conta-secreta-123"
    echo "RCLONE_CONFIG_FORA_KEY=CHAVE-SECRETA-DO-B2"
    echo "AI_CRED_AES_KEY=SENTINELA-DA-CHAVE-DE-CIFRA"
    for linha in "$@"; do echo "$linha"; done
  } > "$P/.env"
}

backup() {  # backup [args...] → OUT e RC. Relógio e timestamp congelados.
  RC=0
  OUT="$(cd "$P" && STUB_LOG="$LOG" BACKUP_FORA_TS=20290101-031700 STUB_DUMP="${STUB_DUMP-$DUMP_BOM}" \
    bash "$KIT_DIR/backup-fora.sh" "$@" 2>&1)" || RC=$?
}
remoto_dir() { printf '%s/bucket/elevcrm/20290101-031700' "$FAKE_REMOTE"; }

# ══ Caminho feliz ════════════════════════════════════════════════════════════
echo "o caminho feliz"
novo_projeto feliz
backup
check "sai 0" test "$RC" -eq 0
check "o banco foi enviado, cifrado" test -s "$(remoto_dir)/db-20290101-031700.sql.gz.age"
check "o .env foi enviado, cifrado" test -s "$(remoto_dir)/env-20290101-031700.age"
check "o manifesto foi enviado" test -s "$(remoto_dir)/MANIFEST-20290101-031700.txt"
check "o manifesto lista o hash dos arquivos" grep -q 'sha256:' "$(remoto_dir)/MANIFEST-20290101-031700.txt"
check "sem volume de QR code: não inventa arquivo de sessão" test -z "$(ls "$(remoto_dir)" | grep waha)"
check "o marcador de sucesso nasceu" test -s "$P/.backup-fora.ok"
check "  e é um epoch numérico (o monitor.sh lê assim)" grep -Eq '^[0-9]+$' "$P/.backup-fora.ok"
check "nenhum arquivo temporário de backup ficou no projeto" test -z "$(ls -A "$P" | grep 'backup-fora-tmp')"

echo "nada em claro"
alguma_cifra_falhou=0
for f in "$(remoto_dir)"/*.age; do head -1 "$f" | grep -q '^AGE-STUB v1$' || alguma_cifra_falhou=1; done
check "todo arquivo .age enviado começa pelo cabeçalho do age" test "$alguma_cifra_falhou" -eq 0
check "o conteúdo do .env NÃO aparece em nenhum arquivo enviado" test -z "$(grep -rl 'SENTINELA-DA-CHAVE-DE-CIFRA' "$FAKE_REMOTE" 2>/dev/null)"
check "nem em nenhum lugar do projeto além do próprio .env" test -z "$(grep -rl 'SENTINELA-DA-CHAVE-DE-CIFRA' "$P" --exclude=.env --exclude=stub.log 2>/dev/null)"

echo "segredos fora da linha de comando"
check "a senha do banco NÃO está na linha do docker" naotem "$(cat "$LOG")" "SENHA-DO-BANCO-9z"
check "o segredo do armazenamento NÃO está na linha do docker" naotem "$(cat "$LOG")" "CHAVE-SECRETA-DO-B2"
check "as credenciais do rclone entram por NOME (-e RCLONE_CONFIG_FORA_KEY)" tem "$(cat "$LOG")" "-e RCLONE_CONFIG_FORA_KEY"
check "o backup NÃO escreve a senha do banco na saída" naotem "$OUT" "SENHA-DO-BANCO-9z"

echo "cifra para quem deve"
check "cifra para a chave pública configurada" tem "$(cat "$LOG")" "age -r $CHAVE1"

novo_projeto duasChaves "BACKUP_AGE_RECIPIENT=$CHAVE1,$CHAVE2"
backup
check "várias chaves públicas: cifra para TODAS (a segunda é a de reserva)" test "$(grep -c "age -r $CHAVE2" "$LOG")" -ge 1

novo_projeto comwaha
STUB_VOLUME_EXISTE=1 backup
check "com volume de QR code: envia as sessões, cifradas" test -s "$(remoto_dir)/waha-20290101-031700.tgz.age"

# ══ Configuração errada: recusa antes de tocar em qualquer coisa ═════════════
echo "configuração"
novo_projeto semdestino "BACKUP_FORA_DESTINO="
backup
check "sem destino: recusa" test "$RC" -ne 0
check "  e diz o que falta" tem "$OUT" "Falta BACKUP_FORA_DESTINO"
check "  deixa rastro em .backup-fora.fail" test -s "$P/.backup-fora.fail"
check "  sem falar com o armazenamento" naotem "$(cat "$LOG")" "rclone"

novo_projeto privada "BACKUP_AGE_RECIPIENT=AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ"
backup
check "chave PRIVADA no .env: recusa (a que decifra tudo não mora na VPS)" tem "$OUT" "chave PRIVADA"
check "  e não envia nada" test -z "$(ls -A "$FAKE_REMOTE")"

novo_projeto invalida "BACKUP_AGE_RECIPIENT=isto-nao-e-chave"
backup
check "chave pública inválida: recusa" tem "$OUT" "inválido"

novo_projeto semdoispontos "BACKUP_FORA_DESTINO=bucket/pasta"
backup
check "destino sem 'remoto:' recusa" tem "$OUT" "remoto:bucket/pasta"

novo_projeto semacesso
STUB_LSF_RC=1 backup
check "destino inacessível: recusa antes de gerar o backup" test "$RC" -ne 0
check "  e aponta credenciais/bucket" tem "$OUT" "Não consegui acessar o destino"
check "  sem rodar o pg_dump" naotem "$(cat "$LOG")" "pg_dump"

# ══ As falhas que NÃO podem carimbar "ok" ════════════════════════════════════
echo "falhas não carimbam sucesso"
ANTIGO=1700000000
backup_com() {  # backup_com VAR=valor [args] → como backup, com uma variável de dublê
  local v="$1"; shift
  RC=0
  OUT="$(cd "$P" && env "$v" STUB_LOG="$LOG" BACKUP_FORA_TS=20290101-031700 STUB_DUMP="${STUB_DUMP-$DUMP_BOM}" \
    bash "$KIT_DIR/backup-fora.sh" "$@" 2>&1)" || RC=$?
}

novo_projeto vazio; echo "$ANTIGO" > "$P/.backup-fora.ok"
STUB_DUMP="" backup
check "dump VAZIO: recusa enviar" test "$RC" -ne 0
check "  diz que não vai enviar um backup que não restaura" tem "$OUT" "vazio ou truncado"
check "  nada chegou ao armazenamento" test -z "$(ls -A "$FAKE_REMOTE")"
check "  e o marcador NÃO foi atualizado (o monitor vai envelhecer e acusar)" test "$(cat "$P/.backup-fora.ok")" = "$ANTIGO"
check "  mas o rastro da falha existe" test -s "$P/.backup-fora.fail"

novo_projeto dumpfalhou; echo "$ANTIGO" > "$P/.backup-fora.ok"
backup_com STUB_DUMP_RC=2
check "pg_dump que falha: recusa" test "$RC" -ne 0
check "  marcador intacto" test "$(cat "$P/.backup-fora.ok")" = "$ANTIGO"
check "  nada enviado" test -z "$(ls -A "$FAKE_REMOTE")"

novo_projeto envio; echo "$ANTIGO" > "$P/.backup-fora.ok"
backup_com STUB_COPY_RC=1
check "envio que falha: recusa" test "$RC" -ne 0
check "  marcador intacto" test "$(cat "$P/.backup-fora.ok")" = "$ANTIGO"
check "  nenhum arquivo temporário sobra" test -z "$(ls -A "$P" | grep 'backup-fora-tmp')"

novo_projeto confere; echo "$ANTIGO" > "$P/.backup-fora.ok"
backup_com STUB_CHECK_RC=1
check "o que chegou NÃO confere com o enviado: recusa" test "$RC" -ne 0
check "  e diz que não confere" tem "$OUT" "NÃO confere"
check "  marcador intacto (enviar sem conferir não é backup)" test "$(cat "$P/.backup-fora.ok")" = "$ANTIGO"

# sucesso depois de falha limpa o rastro da falha
novo_projeto recupera; echo "x" > "$P/.backup-fora.fail"
backup
check "um sucesso apaga o rastro da falha anterior" test ! -e "$P/.backup-fora.fail"

# ══ Um por vez ═══════════════════════════════════════════════════════════════
echo "concorrência"
novo_projeto lock
( exec 8>"$P/.backup-fora.lock"; flock 8; sleep 6 ) &
TRAVA=$!
sleep 1
backup
check "com outro backup em curso: sai 0 sem atropelar" test "$RC" -eq 0
check "  diz que já há um em andamento" tem "$OUT" "em andamento"
check "  e não enviou nada" test -z "$(ls -A "$FAKE_REMOTE")"
kill "$TRAVA" 2>/dev/null; wait "$TRAVA" 2>/dev/null

# ══ --teste ══════════════════════════════════════════════════════════════════
echo "--teste"
novo_projeto teste
backup_com STUB_DELETE_RC=1 --teste
check "chave que NÃO consegue apagar: sai 0 e elogia" tem "$OUT" "NÃO consegue apagar"
check "  não gera backup nenhum" test ! -e "$P/.backup-fora.ok"
check "  e não roda pg_dump" naotem "$(cat "$LOG")" "pg_dump"

novo_projeto teste2
backup_com STUB_DELETE_RC=0 --teste
check "chave que CONSEGUE apagar: AVISA com todas as letras" tem "$OUT" "consegue APAGAR"
check "  mas não é erro (o backup funciona)" test "$RC" -eq 0

novo_projeto teste3
backup_com STUB_COPY_RC=1 --teste
check "sem poder escrever: falha" test "$RC" -ne 0
check "  e diz que falta permissão de escrita" tem "$OUT" "ESCREVER"

novo_projeto opcao
backup --nao-existe
check "opção desconhecida é recusada" test "$RC" -ne 0

echo
if [ "$FAILS" -eq 0 ]; then echo "backup-fora: tudo verde"; exit 0; fi
echo "backup-fora: $FAILS falha(s)"; exit 1
