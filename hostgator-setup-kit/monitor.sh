#!/usr/bin/env bash
# Monitor do servidor: roda por cron a cada 5 minutos e responde UMA pergunta —
# "este servidor está bem?" — para quem não está olhando a tela.
#
#   bash hostgator-setup-kit/monitor.sh        # à mão: imprime o que achou
#
# ── Por que ele existe ──────────────────────────────────────────────────────
# O `healthcheck.sh` é um diagnóstico para quem JÁ sabe que algo está errado. Os
# crons do `scheduler` mandam a saída para /dev/null, o `restart: unless-stopped`
# esconde um contêiner que reinicia em laço, e uma VPS que morre inteira não tem
# como avisar de si mesma. Sem isto, o cliente é quem descobre.
#
# ── Como ele avisa ──────────────────────────────────────────────────────────
# `HEARTBEAT_URL` (no .env) é o endereço de um monitor externo no estilo
# "dead man's switch" (healthchecks.io ou equivalente). A cada rodada:
#
#   tudo bem   → pinga a URL                (o monitor fica verde)
#   problema   → pinga `<URL>/fail`         (o monitor avisa na hora)
#   silêncio   → o monitor avisa sozinho    (a VPS caiu, o cron parou, a rede foi)
#
# A terceira linha é a que importa: só um observador de FORA percebe a falta do
# pinga. Por isso a URL fica fora da VPS e o aviso sai de lá.
#
# Dois níveis, e a diferença é deliberada:
#   PROBLEMA → o cliente já sente, ou vai sentir hoje. Vira `/fail`.
#   AVISO    → vai virar problema se ninguém olhar. Vai no corpo do pinga, sem
#              acordar ninguém. (Um aviso permanente, como "sem backup fora da
#              VPS", não pode virar alarme: alarme que toca todo dia vira ruído.)
#
# Sai 0 sem problema, 1 com problema. O cron ignora o código; ele serve a quem
# roda à mão e ao teste.
#
# Os pontos de injeção `MONITOR_*` existem para o teste (tests/shell/monitor-do-host.test.sh)
# exercitar cada ramo sem uma VPS de verdade.
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=_common.sh
source "$KIT_DIR/_common.sh"

PROBLEMAS=()
AVISOS=()
problema() { PROBLEMAS+=("$*"); }
aviso()    { AVISOS+=("$*"); }

# Epoch de agora. Injetável: o teste congela o relógio.
agora() { printf '%s' "${MONITOR_AGORA:-$(date +%s)}"; }

# ── Docker e os serviços da stack ────────────────────────────────────────────
checar_docker() {
  if ! docker info >/dev/null 2>&1; then
    problema "o Docker não responde — nada do CRM está de pé"
    return 1
  fi
}

# `-a` é essencial: sem ele o `ps` só lista o que está rodando, e um serviço que
# MORREU simplesmente some da lista — a ausência não é lida como falha.
checar_servicos() {
  local servico estado saude total=0
  while IFS='|' read -r servico estado saude; do
    [ -n "$servico" ] || continue
    total=$((total + 1))
    if [ "$estado" != "running" ]; then
      problema "o serviço '$servico' está '$estado'"
    elif [ "$saude" = "unhealthy" ]; then
      problema "o serviço '$servico' está 'unhealthy'"
    fi
  done < <(dc ps -a --format '{{.Service}}|{{.State}}|{{.Health}}' 2>/dev/null || true)
  if [ "$total" -eq 0 ]; then
    problema "nenhum serviço da stack foi encontrado — o CRM está parado"
  fi
}

# Pelo status GERAL que o app declara (healthy|degraded|unhealthy), nunca por grep
# no JSON cru — ver o comentário de `app_health_probe` em _common.sh para o falso
# verde que isso evita.
checar_app() {
  local saida status corpo
  saida="$(app_health_probe)"
  status="$(printf '%s\n' "$saida" | head -1 | tr -d '\r')"
  corpo="$(printf '%s\n' "$saida" | tail -n +2 | head -c 300 || true)"
  case "$status" in
    healthy) ;;
    degraded) aviso "o app responde 'degraded' (um serviço opcional não está configurado ou está falhando)" ;;
    unhealthy) problema "o app responde 'unhealthy': ${corpo}" ;;
    *) problema "o app não respondeu à checagem de saúde" ;;
  esac
}

# ── Recursos do servidor ─────────────────────────────────────────────────────
checar_disco() {
  local caminho usado criticos="${MONITOR_DISCO_CRITICO:-90}" avisos="${MONITOR_DISCO_AVISO:-80}"
  local docker_raiz
  docker_raiz="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
  for caminho in "${MONITOR_DISCO:-/}" ${docker_raiz:+"$docker_raiz"}; do
    [ -e "$caminho" ] || continue
    usado="$(df -P "$caminho" 2>/dev/null | awk 'NR==2 { gsub("%", "", $5); print $5 }')"
    case "$usado" in ''|*[!0-9]*) aviso "não consegui medir o disco em $caminho"; continue;; esac
    if   [ "$usado" -ge "$criticos" ]; then problema "disco em $caminho com ${usado}% de uso"
    elif [ "$usado" -ge "$avisos" ];   then aviso    "disco em $caminho com ${usado}% de uso"
    fi
  done
}

checar_memoria() {
  local arq="${MONITOR_MEMINFO:-/proc/meminfo}" total disp pct
  [ -r "$arq" ] || return 0
  total="$(awk '/^MemTotal:/ { print $2 }' "$arq")"
  disp="$(awk '/^MemAvailable:/ { print $2 }' "$arq")"
  case "${total}${disp}" in ''|*[!0-9]*) return 0;; esac
  [ "$total" -gt 0 ] || return 0
  pct=$(( disp * 100 / total ))
  if   [ "$pct" -lt 5 ];  then problema "memória quase esgotada (${pct}% disponível)"
  elif [ "$pct" -lt 10 ]; then aviso    "pouca memória disponível (${pct}%)"
  fi
}

# ── Backup ───────────────────────────────────────────────────────────────────
# O marcador é escrito pelo backup-fora.sh SÓ depois de a cópia subir e ser
# conferida. Backup que roda e não chega é pior que backup que não roda: dá
# confiança que não existe.
checar_backup() {
  if ! backup_fora_configurado; then
    aviso "sem backup fora da VPS (BACKUP_FORA_DESTINO / BACKUP_AGE_RECIPIENT vazios no .env)"
    return 0
  fi
  conferir_marcador "${MONITOR_BACKUP_MARCADOR:-${PROJECT_DIR:-.}/.backup-fora.ok}" "backup fora da VPS"
}

# A mídia (fotos e áudios dos pacientes) é backup à parte: o do banco não a leva. Mesmo
# critério — marcador que só nasce depois de copiar E conferir — e mesma régua de 30 h.
checar_backup_midia() {
  if ! backup_midia_configurado; then
    aviso "sem backup dos arquivos de mídia (BACKUP_MIDIA_ORIGEM / _DESTINO / _SENHA vazios no .env)"
    return 0
  fi
  conferir_marcador "${MONITOR_BACKUP_MIDIA_MARCADOR:-${PROJECT_DIR:-.}/.backup-midia.ok}" "backup dos arquivos de mídia"
}

# O marcador é um epoch escrito SÓ depois de enviar e conferir. Aqui só se lê a idade dele.
conferir_marcador() {  # conferir_marcador <arquivo> <rótulo>
  local marcador="$1" rotulo="$2"
  local limite_h="${MONITOR_BACKUP_MAX_HORAS:-30}" epoch idade_h
  if [ ! -f "$marcador" ]; then
    aviso "o $rotulo ainda não rodou nenhuma vez"
    return 0
  fi
  epoch="$(head -1 "$marcador" | tr -cd '0-9')"
  [ -n "$epoch" ] || { problema "o marcador do $rotulo está ilegível"; return 0; }
  idade_h=$(( ( $(agora) - epoch ) / 3600 ))
  if [ "$idade_h" -gt "$limite_h" ]; then
    problema "o último $rotulo tem ${idade_h}h (o limite é ${limite_h}h)"
  fi
}

# ── Atualizações do sistema operacional que pedem reinício ───────────────────
# Reinício automático fica desligado de propósito (preparar-host.sh): reiniciar o
# servidor sozinho, às cegas, derruba o atendimento. Mas patch de segurança do
# kernel só vale depois do reinício — então a pendência vira aviso, e some quando
# alguém reinicia numa hora boa.
checar_reinicio() {
  local arq="${MONITOR_REINICIO:-/var/run/reboot-required}"
  [ -e "$arq" ] || return 0
  if [ -n "$(find "$arq" -mtime +7 2>/dev/null)" ]; then
    aviso "o servidor pede reinício há mais de 7 dias (atualização de segurança pendente)"
  fi
}

# ── Certificado HTTPS ────────────────────────────────────────────────────────
# O Caddy/Traefik renova sozinho. Isto só pega o dia em que NÃO renovou — DNS que
# mudou, porta 80 fechada, limite do Let's Encrypt. Sem leitura, só avisa: o monitor
# externo de disponibilidade é quem decide se o site caiu.
checar_certificado() {
  [ "${MONITOR_TLS:-1}" = "1" ] || return 0
  [ -n "${DOMAIN:-}" ] || return 0
  command -v openssl >/dev/null 2>&1 || return 0
  local fim epoch_fim dias
  fim="$(printf '' | timeout 10 openssl s_client -servername "$DOMAIN" -connect "${MONITOR_TLS_ALVO:-127.0.0.1:443}" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
  if [ -z "$fim" ]; then
    aviso "não consegui ler o certificado HTTPS de $DOMAIN"
    return 0
  fi
  epoch_fim="$(date -d "$fim" +%s 2>/dev/null || true)"
  case "$epoch_fim" in ''|*[!0-9]*) aviso "não entendi a data do certificado de $DOMAIN ($fim)"; return 0;; esac
  dias=$(( ( epoch_fim - $(agora) ) / 86400 ))
  if   [ "$dias" -lt 7 ];  then problema "o certificado HTTPS de $DOMAIN vence em ${dias} dia(s)"
  elif [ "$dias" -lt 21 ]; then aviso    "o certificado HTTPS de $DOMAIN vence em ${dias} dias"
  fi
}

# ── Resultado ────────────────────────────────────────────────────────────────
resumo() {
  local linha
  if [ "${#PROBLEMAS[@]}" -eq 0 ]; then
    printf 'OK'
  else
    printf 'PROBLEMA'
  fi
  for linha in "${PROBLEMAS[@]+"${PROBLEMAS[@]}"}"; do printf '\n- %s' "$linha"; done
  for linha in "${AVISOS[@]+"${AVISOS[@]}"}"; do printf '\n- aviso: %s' "$linha"; done
  printf '\n'
}

# Só https://: o corpo do pinga carrega o estado do servidor, e mandá-lo em claro
# para um endereço digitado errado seria vazar sem querer.
heartbeat_valido() {
  case "${HEARTBEAT_URL:-}" in https://?*) return 0;; *) return 1;; esac
}

reportar() {  # reportar <resumo>
  heartbeat_valido || return 0
  local alvo="${HEARTBEAT_URL%/}"
  [ "${#PROBLEMAS[@]}" -eq 0 ] || alvo="${alvo}/fail"
  # A URL é segredo de fato (quem a tem consegue silenciar o alarme): nunca vai
  # para o log nem para a tela, só para o curl.
  curl -fsS -m 10 --retry 3 --retry-delay 2 --data-raw "$1" "$alvo" >/dev/null 2>&1 \
    || registrar "não consegui avisar o monitor externo (HEARTBEAT_URL)"
}

registrar() {  # registrar <mensagem> — log persistente, cortado em ~200 linhas
  local log="${MONITOR_LOG:-${PROJECT_DIR:-.}/.monitor.log}"
  printf '%s [monitor] %s\n' "$(date -u +%FT%TZ)" "$1" >> "$log" 2>/dev/null || return 0
  { tail -n 200 "$log" > "${log}.tmp" && mv "${log}.tmp" "$log"; } 2>/dev/null || true
}

main() {
  enter_project

  if checar_docker; then
    checar_servicos
    checar_app
  fi
  checar_disco
  checar_memoria
  checar_backup
  checar_backup_midia
  checar_reinicio
  checar_certificado

  local texto; texto="$(resumo)"
  printf '%s\n' "$texto"
  registrar "$(printf '%s' "$texto" | head -1) — ${#PROBLEMAS[@]} problema(s), ${#AVISOS[@]} aviso(s)"
  reportar "$texto"

  [ "${#PROBLEMAS[@]}" -eq 0 ]
}

# MONITOR_LIB=1 carrega só as funções (o teste); sem ele, executa.
if [ -z "${MONITOR_LIB:-}" ]; then main "$@"; fi
