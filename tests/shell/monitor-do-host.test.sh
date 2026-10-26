#!/usr/bin/env bash
# Prova do monitor do servidor (`hostgator-setup-kit/monitor.sh`) e dos dois ligadores
# de cron que o acompanham (`setup_monitor_cron`, `setup_backup_fora_cron`).
#
#   bash tests/shell/monitor-do-host.test.sh
#
# ── O que ele guarda ────────────────────────────────────────────────────────
# Um monitor que NÃO acusa é pior que nenhum: dá a certeza de que alguém está
# olhando. Por isso cada checagem é provada nos DOIS sentidos — acusa quando deve e
# fica quieta quando não deve — e o caso que já enganou este kit (o app com o banco
# fora declarado "saudável" porque o check do Redis dizia `"status":"ok"`) tem teste
# próprio.
#
# Nada aqui toca a máquina de quem roda: `docker`, `df`, `openssl`, `curl` e
# `crontab` são dublês que devolvem o que o caso manda, e o relógio é congelado.
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

cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  info)
    if [ "${2:-}" = "-f" ]; then printf '%s\n' "${STUB_DOCKER_ROOT:-}"; exit 0; fi
    exit "${STUB_DOCKER_INFO_RC:-0}" ;;
  compose)
    case " $* " in
      # Como o docker de verdade: SEM `-a` o `ps` só lista o que está rodando, e o
      # serviço que morreu some da lista. É o que torna o `-a` do monitor testável.
      *" ps "*)   if [[ " $* " == *" -a "* ]]; then printf '%s' "${STUB_PS:-}"
                  else printf '%s' "${STUB_PS:-}" | awk -F'|' '$2 == "running"'; fi ;;
      *" exec "*) printf '%s' "${STUB_HEALTH:-}" ;;
    esac ;;
esac
exit 0
STUB

cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${STUB_CURL_LOG:-/dev/null}"
exit "${STUB_CURL_RC:-0}"
STUB

cat > "$WORK/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1K-blocks Used Available Capacity Mounted\n/dev/vda1 1000 500 500 %s%% /\n' "${STUB_DF_PCT:-10}"
STUB

cat > "$WORK/bin/openssl" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  s_client) echo CERT ;;
  x509)     [ -n "${STUB_NOTAFTER:-}" ] && echo "notAfter=${STUB_NOTAFTER}" ; exit 0 ;;
esac
STUB

# `crontab -` de verdade lê a entrada INTEIRA e só então troca o crontab. O dublê
# precisa fazer o mesmo: `cat > arquivo` abriria (e esvaziaria) o arquivo na hora,
# antes de o `crontab -l` do começo do pipe terminar de lê-lo — e o teste perderia
# as linhas pré-existentes por uma corrida que o crontab real não tem.
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  -l) [ -s "$CRON_FILE" ] && cat "$CRON_FILE" || exit 1 ;;
  -)  novo="$(cat)"; printf '%s\n' "$novo" > "$CRON_FILE" ;;
esac
STUB

chmod +x "$WORK"/bin/*
PATH="$WORK/bin:$PATH"
export CRON_FILE="$WORK/crontab.txt"

# Roda UMA função do monitor numa subshell e devolve "P=<n> A=<n>" mais as mensagens.
# Sem `set -e` aqui de propósito — o comportamento sob `set -e` é o da rodada
# completa (`rodar_main`), em processo separado, mais abaixo.
rodar() {
  (
    export MONITOR_LIB=1
    # shellcheck disable=SC1091
    . "$KIT_DIR/monitor.sh" 2>/dev/null
    set +e
    "$@"
    printf 'P=%s A=%s\n' "${#PROBLEMAS[@]}" "${#AVISOS[@]}"
    printf 'p: %s\n' "${PROBLEMAS[@]+"${PROBLEMAS[@]}"}"
    printf 'a: %s\n' "${AVISOS[@]+"${AVISOS[@]}"}"
  )
}

# Relógio congelado: 2029-01-01T00:00:00Z.
AGORA="$(date -u -d '2029-01-01T00:00:00Z' +%s)"
export MONITOR_AGORA="$AGORA"

# ══ Docker e serviços ════════════════════════════════════════════════════════
echo "docker e serviços"

saida="$(STUB_DOCKER_INFO_RC=1 rodar checar_docker)"
check "Docker fora do ar é PROBLEMA" tem "$saida" "P=1"
check "  e a mensagem diz o que isso significa" tem "$saida" "o Docker não responde"

saida="$(rodar checar_docker)"
check "Docker de pé: calado" tem "$saida" "P=0 A=0"

BOM=$'app|running|healthy\nworker|running|healthy\nwaha|running|\nredis|running|healthy\nsrh|running|\nscheduler|running|\ncaddy|running|\n'
saida="$(STUB_PS="$BOM" rodar checar_servicos)"
check "todos os serviços de pé: calado" tem "$saida" "P=0 A=0"

CAIDO=$'app|running|healthy\nworker|exited|\nwaha|running|\n'
saida="$(STUB_PS="$CAIDO" rodar checar_servicos)"
check "serviço que MORREU (exited) é PROBLEMA" tem "$saida" "P=1"
check "  e o nome do serviço aparece" tem "$saida" "'worker' está 'exited'"

REINICIANDO=$'app|running|healthy\nworker|restarting|\n'
saida="$(STUB_PS="$REINICIANDO" rodar checar_servicos)"
check "serviço em laço de reinício é PROBLEMA" tem "$saida" "'worker' está 'restarting'"

DOENTE=$'app|running|unhealthy\nworker|running|healthy\n'
saida="$(STUB_PS="$DOENTE" rodar checar_servicos)"
check "serviço 'unhealthy' é PROBLEMA" tem "$saida" "'app' está 'unhealthy'"

saida="$(STUB_PS="" rodar checar_servicos)"
check "NENHUM serviço listado é PROBLEMA (stack parada), não silêncio" tem "$saida" "nenhum serviço da stack foi encontrado"

# ══ Saúde do app ═════════════════════════════════════════════════════════════
echo "saúde do app"

saida="$(STUB_HEALTH=$'healthy\n{"data":{"status":"healthy"}}\n' rodar checar_app)"
check "app 'healthy': calado" tem "$saida" "P=0 A=0"

saida="$(STUB_HEALTH=$'degraded\n{"data":{"status":"degraded"}}\n' rodar checar_app)"
check "app 'degraded' é AVISO, não problema (serviço opcional)" tem "$saida" "P=0 A=1"

# O falso verde que já enganou este kit: o app com o banco FORA, mas o JSON traz
# `"status":"ok"` no check do Redis. Quem procurava essa string declarava saudável.
FALSO_VERDE=$'unhealthy\n{"data":{"status":"unhealthy","checks":{"supabase":{"status":"down"},"redis":{"status":"ok"}}}}\n'
saida="$(STUB_HEALTH="$FALSO_VERDE" rodar checar_app)"
check "app 'unhealthy' com o Redis 'ok' no JSON é PROBLEMA (o falso verde)" tem "$saida" "P=1"
check "  e o corpo da resposta acompanha a mensagem" tem "$saida" '"supabase":{"status":"down"}'

saida="$(STUB_HEALTH="" rodar checar_app)"
check "app que não responde nada é PROBLEMA, e não só um aviso" tem "$saida" "P=1 A=0"
check "  e a mensagem diz o que houve" tem "$saida" "o app não respondeu à checagem de saúde"

# ══ Disco ════════════════════════════════════════════════════════════════════
echo "disco"
saida="$(STUB_DF_PCT=95 rodar checar_disco)"
check "95% é PROBLEMA" tem "$saida" "P=1"
saida="$(STUB_DF_PCT=85 rodar checar_disco)"
check "85% é AVISO" tem "$saida" "P=0 A=1"
saida="$(STUB_DF_PCT=40 rodar checar_disco)"
check "40%: calado" tem "$saida" "P=0 A=0"
saida="$(STUB_DF_PCT=90 rodar checar_disco)"
check "o limite é inclusivo: 90% já é PROBLEMA" tem "$saida" "P=1"

# ══ Memória ══════════════════════════════════════════════════════════════════
echo "memória"
meminfo() { printf 'MemTotal:       1000 kB\nMemAvailable:   %s kB\n' "$1" > "$WORK/meminfo"; }
meminfo 40;  saida="$(MONITOR_MEMINFO="$WORK/meminfo" rodar checar_memoria)"
check "4% disponível é PROBLEMA" tem "$saida" "P=1"
meminfo 80;  saida="$(MONITOR_MEMINFO="$WORK/meminfo" rodar checar_memoria)"
check "8% disponível é AVISO" tem "$saida" "P=0 A=1"
meminfo 500; saida="$(MONITOR_MEMINFO="$WORK/meminfo" rodar checar_memoria)"
check "50% disponível: calado" tem "$saida" "P=0 A=0"
saida="$(MONITOR_MEMINFO="$WORK/nao-existe" rodar checar_memoria)"
check "sem /proc/meminfo: calado (não inventa problema)" tem "$saida" "P=0 A=0"

# ══ Backup ═══════════════════════════════════════════════════════════════════
echo "backup fora da VPS"
MARC="$WORK/marcador"
saida="$(MONITOR_BACKUP_MARCADOR="$MARC" rodar checar_backup)"
check "sem backup configurado: AVISO permanente, nunca problema" tem "$saida" "P=0 A=1"

CONF=(BACKUP_FORA_DESTINO="fora:bucket/x" BACKUP_AGE_RECIPIENT="age1abc")
rm -f "$MARC"
saida="$(env "${CONF[@]}" MONITOR_BACKUP_MARCADOR="$MARC" bash -c 'MONITOR_LIB=1 . "$1"/monitor.sh 2>/dev/null; set +e; checar_backup; echo "P=${#PROBLEMAS[@]} A=${#AVISOS[@]}"' x "$KIT_DIR")"
check "configurado e que nunca rodou: AVISO (recém-instalado não é alarme)" tem "$saida" "P=0 A=1"

printf '%s\n' "$((AGORA - 3600 * 5))" > "$MARC"
saida="$(env "${CONF[@]}" MONITOR_BACKUP_MARCADOR="$MARC" bash -c 'MONITOR_LIB=1 . "$1"/monitor.sh 2>/dev/null; set +e; checar_backup; echo "P=${#PROBLEMAS[@]} A=${#AVISOS[@]}"' x "$KIT_DIR")"
check "backup de 5h atrás: calado" tem "$saida" "P=0 A=0"

printf '%s\n' "$((AGORA - 3600 * 40))" > "$MARC"
saida="$(env "${CONF[@]}" MONITOR_BACKUP_MARCADOR="$MARC" bash -c 'MONITOR_LIB=1 . "$1"/monitor.sh 2>/dev/null; set +e; checar_backup; echo "P=${#PROBLEMAS[@]} A=${#AVISOS[@]}"; printf "%s\n" "${PROBLEMAS[@]}"' x "$KIT_DIR")"
check "backup de 40h atrás é PROBLEMA" tem "$saida" "P=1"
check "  e a mensagem diz quantas horas" tem "$saida" "tem 40h"

printf 'lixo\n' > "$MARC"
saida="$(env "${CONF[@]}" MONITOR_BACKUP_MARCADOR="$MARC" bash -c 'MONITOR_LIB=1 . "$1"/monitor.sh 2>/dev/null; set +e; checar_backup; echo "P=${#PROBLEMAS[@]} A=${#AVISOS[@]}"' x "$KIT_DIR")"
check "marcador ilegível é PROBLEMA (não finge que está em dia)" tem "$saida" "P=1"

# Só a destino, sem a chave: NÃO é "configurado" — mandaria o backup em claro.
saida="$(env BACKUP_FORA_DESTINO="fora:x" MONITOR_BACKUP_MARCADOR="$MARC" bash -c 'MONITOR_LIB=1 . "$1"/monitor.sh 2>/dev/null; set +e; checar_backup; echo "P=${#PROBLEMAS[@]} A=${#AVISOS[@]}"' x "$KIT_DIR")"
check "destino sem chave pública NÃO conta como configurado" tem "$saida" "P=0 A=1"

# ══ Reinício pendente ════════════════════════════════════════════════════════
echo "reinício pendente"
touch -d '8 days ago' "$WORK/reboot-velho"
touch "$WORK/reboot-novo"
saida="$(MONITOR_REINICIO="$WORK/reboot-velho" rodar checar_reinicio)"
check "pedido de reinício há 8 dias é AVISO" tem "$saida" "P=0 A=1"
saida="$(MONITOR_REINICIO="$WORK/reboot-novo" rodar checar_reinicio)"
check "pedido de reinício de agora: calado" tem "$saida" "P=0 A=0"
saida="$(MONITOR_REINICIO="$WORK/nao-existe" rodar checar_reinicio)"
check "sem arquivo de reinício: calado" tem "$saida" "P=0 A=0"

# ══ Certificado ══════════════════════════════════════════════════════════════
echo "certificado HTTPS"
cert() { STUB_NOTAFTER="$1" DOMAIN="crm.exemplo.com.br" rodar checar_certificado; }
saida="$(cert 'Jan  4 00:00:00 2029 GMT')"
check "vence em 3 dias é PROBLEMA" tem "$saida" "P=1"
saida="$(cert 'Jan 15 00:00:00 2029 GMT')"
check "vence em 14 dias é AVISO" tem "$saida" "P=0 A=1"
saida="$(cert 'Mar  1 00:00:00 2029 GMT')"
check "vence em 59 dias: calado" tem "$saida" "P=0 A=0"
saida="$(cert '')"
check "não conseguiu ler o certificado: AVISO (o monitor de fora decide se caiu)" tem "$saida" "P=0 A=1"
saida="$(MONITOR_TLS=0 cert 'Jan  4 00:00:00 2029 GMT')"
check "MONITOR_TLS=0 desliga a checagem" tem "$saida" "P=0 A=0"
saida="$(STUB_NOTAFTER='Jan  4 00:00:00 2029 GMT' DOMAIN='' rodar checar_certificado)"
check "sem DOMAIN no .env: calado" tem "$saida" "P=0 A=0"

# ══ A rodada completa (processo separado, sob set -e como no cron) ═══════════
echo "a rodada completa"
PROJ="$WORK/proj"; mkdir -p "$PROJ"
: > "$PROJ/docker-compose.prod.yml"
SEGREDO_URL="https://hc.exemplo.test/ping/ESTE-SEGREDO-NAO-PODE-VAZAR"
printf 'HEARTBEAT_URL=%s\nMONITOR_TLS_X=1\n' "$SEGREDO_URL" > "$PROJ/.env"

rodar_main() {  # rodar_main → imprime a saída; o código de saída vai em $RC
  RC=0
  OUT="$(cd "$PROJ" && MONITOR_TLS=0 STUB_CURL_LOG="$WORK/curl.log" MONITOR_REINICIO="$WORK/nao-existe" \
    MONITOR_MEMINFO="$WORK/meminfo" bash "$KIT_DIR/monitor.sh" 2>&1)" || RC=$?
}
meminfo 500
HEALTHY=$'healthy\n{"data":{"status":"healthy"}}\n'

: > "$WORK/curl.log"; rm -f "$PROJ/.monitor.log"
STUB_PS="$BOM" STUB_HEALTH="$HEALTHY" STUB_DF_PCT=30 rodar_main
check "tudo bem: sai 0" test "$RC" -eq 0
check "  imprime OK" tem "$OUT" "OK"
check "  pinga a URL do monitor, sem /fail" grep -qF -- "$SEGREDO_URL" "$WORK/curl.log"
check "  e NÃO pinga /fail" naotem "$(cat "$WORK/curl.log")" "/fail"
check "  grava a rodada no log do projeto" test -s "$PROJ/.monitor.log"
check "  a URL secreta NÃO aparece na saída" naotem "$OUT" "ESTE-SEGREDO"
check "  nem no log" naotem "$(cat "$PROJ/.monitor.log")" "ESTE-SEGREDO"

: > "$WORK/curl.log"
STUB_PS="$CAIDO" STUB_HEALTH="$HEALTHY" STUB_DF_PCT=30 rodar_main
check "serviço morto: sai 1" test "$RC" -eq 1
check "  imprime PROBLEMA e o serviço" tem "$OUT" "'worker' está 'exited'"
check "  pinga <URL>/fail" grep -qF -- "${SEGREDO_URL}/fail" "$WORK/curl.log"
check "  manda o resumo no corpo do pinga" grep -qF -- "worker" "$WORK/curl.log"

: > "$WORK/curl.log"
STUB_DOCKER_INFO_RC=1 STUB_PS="$BOM" STUB_HEALTH="$HEALTHY" STUB_DF_PCT=30 rodar_main
check "Docker fora: sai 1 e pinga /fail" grep -qF -- "${SEGREDO_URL}/fail" "$WORK/curl.log"
check "  sem Docker, não tenta listar serviços (uma causa, uma mensagem)" naotem "$OUT" "nenhum serviço da stack"

: > "$WORK/curl.log"
STUB_PS="$BOM" STUB_HEALTH="$HEALTHY" STUB_DF_PCT=30 STUB_CURL_RC=22 rodar_main
check "o monitor externo recusou o pinga: não derruba a rodada" test "$RC" -eq 0
check "  mas deixa rastro no log" grep -qF "não consegui avisar o monitor externo" "$PROJ/.monitor.log"

# HEARTBEAT_URL sem https: nunca sai para fora.
printf 'HEARTBEAT_URL=http://hc.exemplo.test/x\n' > "$PROJ/.env"
: > "$WORK/curl.log"
STUB_PS="$BOM" STUB_HEALTH="$HEALTHY" STUB_DF_PCT=30 rodar_main
check "HEARTBEAT_URL em http:// não é chamada" test ! -s "$WORK/curl.log"
printf '\n' > "$PROJ/.env"
STUB_PS="$BOM" STUB_HEALTH="$HEALTHY" STUB_DF_PCT=30 rodar_main
check "sem HEARTBEAT_URL a rodada funciona (só local)" test "$RC" -eq 0

# O log não cresce sem limite.
printf 'HEARTBEAT_URL=%s\n' "$SEGREDO_URL" > "$PROJ/.env"
for i in $(seq 1 300); do echo "linha $i" >> "$PROJ/.monitor.log"; done
STUB_PS="$BOM" STUB_HEALTH="$HEALTHY" STUB_DF_PCT=30 rodar_main
check "o log é cortado em ~200 linhas" test "$(wc -l < "$PROJ/.monitor.log")" -le 201

# ══ Os ligadores de cron ═════════════════════════════════════════════════════
echo "ligadores de cron"
cron_rodar() {  # cron_rodar <função> [VAR=valor...]  (numa subshell, com o crontab de mentira)
  local fn="$1"; shift
  ( env "$@" bash -c '. "$0"/_common.sh >/dev/null 2>&1; set +e; "$1"' "$KIT_DIR" "$fn" ) >/dev/null 2>&1
}
linhas() { grep -c -- "$1" "$CRON_FILE" 2>/dev/null || true; }

: > "$CRON_FILE"
cron_rodar setup_monitor_cron PROJECT_DIR=/srv/a HEARTBEAT_URL=https://hc.exemplo.test/x
check "monitor: liga a linha, a cada 5 minutos" grep -q '^\*/5 \* \* \* \* cd /srv/a && bash hostgator-setup-kit/monitor.sh' "$CRON_FILE"
cron_rodar setup_monitor_cron PROJECT_DIR=/srv/a HEARTBEAT_URL=https://hc.exemplo.test/x
check "monitor: rodar de novo NÃO duplica" test "$(linhas 'monitor.sh')" -eq 1
cron_rodar setup_monitor_cron PROJECT_DIR=/srv/b HEARTBEAT_URL=https://hc.exemplo.test/x
check "monitor: uma segunda instalação não apaga a primeira" test "$(linhas 'monitor.sh')" -eq 2

: > "$CRON_FILE"
cron_rodar setup_monitor_cron PROJECT_DIR=/srv/a HEARTBEAT_URL=
check "monitor: sem HEARTBEAT_URL não liga nada" test ! -s "$CRON_FILE"
cron_rodar setup_monitor_cron PROJECT_DIR=/srv/a HEARTBEAT_URL=http://hc.exemplo.test/x
check "monitor: HEARTBEAT_URL em http:// não liga nada" test ! -s "$CRON_FILE"

printf '*/5 * * * * cd /srv/a && bash hostgator-setup-kit/agent.sh >/dev/null 2>&1 # elevcrm:/srv/a:agent\n' > "$CRON_FILE"
cron_rodar setup_monitor_cron PROJECT_DIR=/srv/a HEARTBEAT_URL=https://hc.exemplo.test/x
check "monitor: preserva a linha do agente de atualização" grep -q 'agent.sh' "$CRON_FILE"

: > "$CRON_FILE"
cron_rodar setup_backup_fora_cron PROJECT_DIR=/srv/a BACKUP_FORA_DESTINO=fora:b/x BACKUP_AGE_RECIPIENT=age1abc
check "backup-fora: liga às 03:17" grep -q '^17 3 \* \* \* cd /srv/a && bash hostgator-setup-kit/backup-fora.sh' "$CRON_FILE"
check "  e guarda a saída num arquivo (falha precisa deixar a causa)" grep -qF -- '>> /srv/a/.backup-fora.log 2>&1' "$CRON_FILE"
cron_rodar setup_backup_fora_cron PROJECT_DIR=/srv/a BACKUP_FORA_DESTINO=fora:b/x BACKUP_AGE_RECIPIENT=age1abc
check "backup-fora: rodar de novo NÃO duplica" test "$(linhas 'backup-fora.sh')" -eq 1

: > "$CRON_FILE"
cron_rodar setup_backup_fora_cron PROJECT_DIR=/srv/a BACKUP_FORA_DESTINO=fora:b/x BACKUP_AGE_RECIPIENT=
check "backup-fora: destino SEM chave pública não liga (mandaria em claro)" test ! -s "$CRON_FILE"
cron_rodar setup_backup_fora_cron PROJECT_DIR=/srv/a BACKUP_FORA_DESTINO= BACKUP_AGE_RECIPIENT=age1abc
check "backup-fora: chave sem destino não liga" test ! -s "$CRON_FILE"

echo
if [ "$FAILS" -eq 0 ]; then echo "monitor-do-host: tudo verde"; exit 0; fi
echo "monitor-do-host: $FAILS falha(s)"; exit 1
