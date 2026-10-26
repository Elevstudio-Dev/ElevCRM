#!/usr/bin/env bash
# Prepara um servidor NOVO (Debian/Ubuntu) para operar o Elev CRM 24 horas por dia.
#
#   sudo bash hostgator-setup-kit/preparar-host.sh [opções]
#
#   --dry-run        mostra o que faria e não muda nada (pode rodar sem ser root)
#   --yes            não pergunta antes de aplicar
#   --porta-ssh N    libera também a porta N no firewall (repita a flag para várias)
#   --ssh-so-chave   desliga a senha no SSH (só entra com chave) — veja o aviso abaixo
#   --sem-swap       não cria arquivo de swap
#
# Roda ANTES do install.sh, uma vez por servidor. É idempotente: rodar de novo
# confere cada item e só mexe no que mudou.
#
# ── O que ele faz, e por que cada coisa importa para ficar no ar ────────────
#   firewall (ufw)        só SSH, 80 e 443 recebem conexão de fora
#   fail2ban              bloqueia quem tenta adivinhar a senha do SSH
#   atualizações          patches de SEGURANÇA aplicados sozinhos — sem reiniciar
#                         o servidor sozinho (ver abaixo)
#   swap                  folga de memória; sem ela o primeiro pico mata um serviço
#   Docker no boot        depois de um reinício, a stack volta sem ninguém
#   relógio (NTP)         certificados HTTPS e assinatura de webhook dependem da hora
#
# ── Três decisões que não são óbvias ────────────────────────────────────────
# 1. A porta do SSH é descoberta e liberada ANTES de o firewall ser ligado. Alguns
#    provedores usam SSH em porta diferente de 22; ligar o firewall liberando só a
#    22 tranca para fora quem está conectado (CLAUDE.md do kit, armadilha 1). A
#    porta da conexão ATUAL (SSH_CONNECTION) é a que mais importa, e entra sempre.
# 2. Reinício automático fica DESLIGADO. Reiniciar às cegas derruba o atendimento.
#    O custo é que patch de kernel só vale depois do reinício: o monitor.sh avisa
#    quando o servidor pede reinício há mais de 7 dias, e quem opera escolhe a hora.
# 3. O firewall NÃO protege portas publicadas pelo Docker — o Docker escreve as
#    próprias regras de rede e passa por cima do ufw. Hoje só o proxy (80/443)
#    publica porta; se alguém um dia publicar outra (ex.: "5432:5432"), o ufw não
#    a barra. Por isso o compose deste kit não publica nada além do proxy.
#
# ⚠️ --ssh-so-chave: só ligue depois de conferir, EM OUTRA JANELA, que a sua chave
#    entra. O script recusa se não achar nenhuma chave autorizada e valida a
#    configuração antes de recarregar — mas não consegue saber se a chave que está
#    lá é a que você tem.
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=_common.sh
source "$KIT_DIR/_common.sh"

DRY_RUN=0; ASSUME_YES=0; SEM_SWAP=0; SSH_SO_CHAVE=0
PORTAS_EXTRAS=()
MUDOU=()    # o que foi alterado nesta rodada
JA_ESTAVA=()  # o que já estava como deveria

# Prefixo dos caminhos do sistema — o teste aponta para uma pasta temporária.
RAIZ="${PREPARAR_RAIZ:-}"
caminho() { printf '%s%s' "$RAIZ" "$1"; }

# Em --dry-run só imprime; fora dele executa. Todo comando que MUDA o servidor passa
# por aqui, e é por isso que o dry-run é confiável: não há outro caminho de escrita.
executar() {
  if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; return 0; fi
  "$@"
}

# Igual a `executar`, mas sem o ruído do comando (ufw, mkswap, systemctl...). O
# silêncio vive AQUI, e não num `>/dev/null` do chamador, porque o redirecionamento de
# fora engoliria também a linha do --dry-run e o plano ficaria invisível.
quieto() {
  if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; return 0; fi
  "$@" >/dev/null 2>&1
}

# Grava um arquivo só se o conteúdo mudou. Devolve 0 se escreveu, 1 se já estava igual.
gravar_arquivo() {  # gravar_arquivo <caminho> <conteúdo> [modo]
  local destino="$1" conteudo="$2" modo="${3:-644}"
  if [ -f "$destino" ] && [ "$(cat "$destino")" = "$conteudo" ]; then return 1; fi
  if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] gravaria %s\n' "$destino"; return 0; fi
  mkdir -p "$(dirname "$destino")"
  printf '%s\n' "$conteudo" > "$destino"
  chmod "$modo" "$destino"
}

registrar_mudanca() {
  if [ "$DRY_RUN" = 1 ]; then c_dim "  → faria: $1"; return 0; fi
  MUDOU+=("$1"); c_grn "✓ $1"
}
registrar_ja_estava() { JA_ESTAVA+=("$1"); c_dim "  já estava: $1"; }

# ── Portas do SSH ────────────────────────────────────────────────────────────
# Une TODAS as fontes e tira repetidas. Prefere sobrar porta liberada a faltar:
# porta a mais no firewall é um risco pequeno; porta a menos é ficar trancado fora.
portas_ssh() {
  {
    # a porta da conexão em que você está AGORA: quarto campo de SSH_CONNECTION
    # ("ip_cliente porta_cliente ip_servidor porta_servidor")
    if [ -n "${SSH_CONNECTION:-}" ]; then
      set -- $SSH_CONNECTION
      [ -n "${4:-}" ] && printf '%s\n' "$4"
    fi
    # o que o sshd diz que escuta (precisa de root)
    if command -v sshd >/dev/null 2>&1; then
      sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' || true
    fi
    # o que realmente está escutando como sshd
    if command -v ss >/dev/null 2>&1; then
      ss -tlnH 2>/dev/null | awk '/sshd/ { n = split($4, a, ":"); print a[n] }' || true
    fi
    local p
    for p in "${PORTAS_EXTRAS[@]+"${PORTAS_EXTRAS[@]}"}"; do printf '%s\n' "$p"; done
  } | { grep -E '^[0-9]+$' || true; } | sort -un
}

# ── Passos ───────────────────────────────────────────────────────────────────
passo_pacotes() {
  step "Pacotes de segurança e de apoio"
  local pacotes="ufw fail2ban unattended-upgrades age cron curl ca-certificates openssl"
  local faltando="" p
  for p in $pacotes; do
    dpkg -s "$p" >/dev/null 2>&1 || faltando="$faltando $p"
  done
  if [ -z "$faltando" ]; then registrar_ja_estava "pacotes instalados"; return 0; fi
  executar apt-get update -qq
  # shellcheck disable=SC2086
  executar env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $faltando
  registrar_mudanca "pacotes instalados:$faltando"
}

passo_atualizacoes() {
  step "Atualizações de segurança automáticas (sem reiniciar o servidor sozinho)"
  local mudou=0
  gravar_arquivo "$(caminho /etc/apt/apt.conf.d/20auto-upgrades)" \
'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' && mudou=1
  gravar_arquivo "$(caminho /etc/apt/apt.conf.d/52elevcrm-unattended)" \
'// Reiniciar o servidor sozinho derruba o atendimento. O monitor.sh avisa quando
// há reinício pendente; quem opera escolhe a hora.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";' && mudou=1
  if [ "$mudou" = 1 ]; then registrar_mudanca "atualizações de segurança automáticas, sem reinício automático"
  else registrar_ja_estava "atualizações de segurança automáticas"; fi
}

passo_fail2ban() {
  step "Bloqueio de tentativas de invasão (fail2ban)"
  local portas; portas="$(portas_ssh | paste -sd, -)"
  [ -n "$portas" ] || die "Não descobri a porta do SSH. Passe --porta-ssh N."
  if gravar_arquivo "$(caminho /etc/fail2ban/jail.d/elevcrm.local)" \
"[sshd]
enabled  = true
port     = ${portas}
maxretry = 5
findtime = 10m
bantime  = 1h"; then
    registrar_mudanca "fail2ban vigiando o SSH (porta(s) ${portas}): 5 erros em 10 min = 1 hora de bloqueio"
  else
    registrar_ja_estava "fail2ban vigiando o SSH"
  fi
  if command -v systemctl >/dev/null 2>&1; then
    quieto systemctl enable --now fail2ban || c_ylw "⚠ não consegui ligar o fail2ban — confira: systemctl status fail2ban"
    quieto systemctl restart fail2ban || true
  fi
}

passo_firewall() {
  step "Firewall (ufw): só SSH, 80 e 443"
  local portas p
  portas="$(portas_ssh)"
  [ -n "$portas" ] || die "Não descobri a porta do SSH — não vou ligar o firewall às cegas. Passe --porta-ssh N."
  c_dim "  portas de SSH que serão liberadas: $(printf '%s' "$portas" | paste -sd' ' -)"
  quieto ufw default deny incoming
  quieto ufw default allow outgoing
  # O SSH ANTES do enable. Esta ordem é o ponto inteiro do passo.
  for p in $portas; do quieto ufw allow "${p}/tcp"; done
  quieto ufw allow 80/tcp
  quieto ufw allow 443/tcp
  quieto ufw --force enable
  registrar_mudanca "firewall ligado: SSH ($(printf '%s' "$portas" | paste -sd, -)), 80 e 443"
}

passo_swap() {
  step "Swap (folga de memória)"
  if [ "$SEM_SWAP" = 1 ]; then registrar_ja_estava "swap dispensado (--sem-swap)"; return 0; fi
  local meminfo="${PREPARAR_MEMINFO:-/proc/meminfo}" total_kb
  total_kb="$(awk '/^MemTotal:/ { print $2 }' "$meminfo" 2>/dev/null || echo 0)"
  if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then registrar_ja_estava "já há swap ativo"; return 0; fi
  # 8 GiB ou mais: o app, o worker e o WhatsApp cabem com folga; swap só esconderia
  # um vazamento.
  if [ "$total_kb" -ge 8000000 ]; then registrar_ja_estava "memória de sobra ($((total_kb / 1024)) MiB) — sem swap"; return 0; fi
  local livre_kb; livre_kb="$(df -Pk "$(caminho /)" 2>/dev/null | awk 'NR==2 { print $4 }')"
  if [ "${livre_kb:-0}" -lt 8000000 ]; then
    c_ylw "⚠ pouco espaço livre em disco ($((${livre_kb:-0} / 1024)) MiB) — não criei o swap."
    return 0
  fi
  local arq; arq="$(caminho /swapfile)"
  executar fallocate -l 2G "$arq" || executar dd if=/dev/zero of="$arq" bs=1M count=2048 status=none
  executar chmod 600 "$arq"
  quieto mkswap "$arq"
  executar swapon "$arq"
  local fstab; fstab="$(caminho /etc/fstab)"
  if ! grep -qE '^[^#]*[[:space:]]swap[[:space:]]' "$fstab" 2>/dev/null; then
    if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] acrescentaria o swap ao %s\n' "$fstab"
    else printf '/swapfile none swap sw 0 0\n' >> "$fstab"; fi
  fi
  gravar_arquivo "$(caminho /etc/sysctl.d/99-elevcrm.conf)" 'vm.swappiness = 10' >/dev/null || true
  quieto sysctl -q -p "$(caminho /etc/sysctl.d/99-elevcrm.conf)" || true
  registrar_mudanca "swap de 2 GiB criado e persistido"
}

passo_docker_no_boot() {
  step "Docker volta sozinho depois de um reinício"
  if ! command -v systemctl >/dev/null 2>&1; then c_ylw "⚠ sem systemd — confira à mão que o Docker sobe no boot."; return 0; fi
  if ! command -v docker >/dev/null 2>&1; then
    c_dim "  Docker ainda não instalado — o install.sh instala. Rode este passo de novo depois."
    return 0
  fi
  if systemctl is-enabled docker >/dev/null 2>&1; then registrar_ja_estava "Docker habilitado no boot"
  else quieto systemctl enable docker && registrar_mudanca "Docker habilitado no boot"; fi
}

passo_relogio() {
  step "Relógio sincronizado (NTP)"
  if ! command -v timedatectl >/dev/null 2>&1; then c_dim "  sem timedatectl — confira o relógio à mão."; return 0; fi
  if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ]; then
    registrar_ja_estava "relógio sincronizado"
  else
    quieto timedatectl set-ntp true && registrar_mudanca "sincronização de relógio ligada"
  fi
}

passo_ssh_so_chave() {
  [ "$SSH_SO_CHAVE" = 1 ] || return 0
  step "SSH só com chave (senha desligada)"
  local chaves="" f
  for f in "$(caminho /root/.ssh/authorized_keys)" "${HOME:-/root}/.ssh/authorized_keys"; do
    [ -s "$f" ] && chaves="$f" && break
  done
  [ -n "$chaves" ] || die "Não achei nenhuma chave em authorized_keys — desligar a senha agora trancaria você para fora. Instale a sua chave primeiro (ssh-copy-id)."
  # `00-`, e NÃO `99-`: o sshd lê /etc/ssh/sshd_config.d/*.conf em ordem alfabética e vale o
  # PRIMEIRO valor de cada diretiva. As imagens de nuvem (Hostinger, e qualquer cloud-init)
  # trazem um `50-cloud-init.conf` com `PasswordAuthentication yes`; um arquivo nosso que
  # viesse DEPOIS dele perdia — e o script anunciava "SSH só com chave" com a senha ainda
  # ligada (achado na primeira VPS real, 2026-10-26, pela prova de que a senha é recusada).
  local conf; conf="$(caminho /etc/ssh/sshd_config.d/00-elevcrm.conf)"
  local legado; legado="$(caminho /etc/ssh/sshd_config.d/99-elevcrm.conf)"   # nome da 1.17.0: nunca valeu
  local novo='PasswordAuthentication no
PermitRootLogin prohibit-password'
  # "Já estava" só vale se o valor EFETIVO também é `no`: arquivo certo com outro arquivo
  # mandando mais alto é exatamente o defeito acima, e dizer "já estava" o esconderia.
  if [ -f "$conf" ] && [ "$(cat "$conf")" = "$novo" ] && [ ! -f "$legado" ] && [ "$(senha_efetiva_do_sshd)" = "no" ]; then
    registrar_ja_estava "SSH só com chave"; return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] gravaria %s e recarregaria o sshd\n' "$conf"; return 0; fi
  local anterior=""; [ -f "$conf" ] && anterior="$(cat "$conf")"
  rm -f "$legado"
  gravar_arquivo "$conf" "$novo" >/dev/null
  # Valida ANTES de recarregar: configuração inválida + reload = sshd fora do ar.
  if ! sshd -t 2>/dev/null; then
    if [ -n "$anterior" ]; then printf '%s\n' "$anterior" > "$conf"; else rm -f "$conf"; fi
    die "O sshd recusou a configuração — desfiz a mudança e não recarreguei nada."
  fi
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || c_ylw "⚠ não consegui recarregar o sshd — faça: systemctl reload ssh"
  # A PROVA é o valor que o sshd USA agora (`sshd -T`), não o arquivo que gravei: sucesso
  # anunciado sobre um arquivo que perde para outro é o pior tipo de falha de segurança —
  # a pessoa acha que a senha está desligada e ela está ligada.
  if [ "$(senha_efetiva_do_sshd)" != "no" ]; then
    if [ -n "$anterior" ]; then printf '%s\n' "$anterior" > "$conf"; else rm -f "$conf"; fi
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    die "O sshd continua aceitando SENHA: outro arquivo em /etc/ssh/sshd_config.d/ ou no sshd_config manda mais alto que o do kit. Desfiz a mudança. Veja: grep -in PasswordAuthentication /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf"
  fi
  registrar_mudanca "SSH só com chave (confirmado: o sshd recusa senha)"
  c_ylw "  ⚠ NÃO feche esta sessão ainda: abra outra janela e confirme que sua chave entra."
}

# O valor de `PasswordAuthentication` que o sshd USA agora (e não o que algum arquivo diz).
senha_efetiva_do_sshd() { sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" { print $2; exit }'; }

# ── Execução ─────────────────────────────────────────────────────────────────
resumo_final() {
  printf '\n'
  if [ "$DRY_RUN" = 1 ]; then c_ylw "Nada foi alterado (--dry-run)."; return 0; fi
  c_grn "Servidor preparado. Alterado nesta rodada: ${#MUDOU[@]} item(ns); já estavam certos: ${#JA_ESTAVA[@]}."
  cat <<'PROXIMO'

  Falta, e isto NÃO dá para fazer de dentro do servidor:
    1. Ligar os backups automáticos (snapshots) no painel do provedor da VPS.
    2. Se o painel tiver firewall próprio, repetir lá: SSH, 80 e 443.
    3. Rodar o install.sh e, depois, configurar HEARTBEAT_URL e o backup fora da
       VPS no .env — docs/runbooks/operacao-24h.md.
PROXIMO
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --yes) ASSUME_YES=1 ;;
      --sem-swap) SEM_SWAP=1 ;;
      --ssh-so-chave) SSH_SO_CHAVE=1 ;;
      --porta-ssh) shift; PORTAS_EXTRAS+=("${1:-}") ;;
      *) die "Opção desconhecida: $1" ;;
    esac
    shift
  done
  case "${PORTAS_EXTRAS[*]:-}" in *[!0-9\ ]*) die "--porta-ssh precisa de um número." ;; esac

  command -v apt-get >/dev/null 2>&1 || die "Este script é para Debian/Ubuntu (usa apt). Em outra distribuição, faça os passos à mão — veja docs/runbooks/operacao-24h.md."
  if [ "$DRY_RUN" = 0 ] && [ "${PREPARAR_UID:-$(id -u)}" -ne 0 ]; then
    die "Rode como root (sudo bash hostgator-setup-kit/preparar-host.sh). Para só ver o plano: --dry-run."
  fi

  if [ "$DRY_RUN" = 0 ] && [ "$ASSUME_YES" = 0 ]; then
    c_ylw "Isto vai ligar o firewall, o fail2ban, as atualizações automáticas e (se precisar) criar swap."
    c_dim "  Portas de SSH que ficarão abertas: $(portas_ssh | paste -sd' ' -)"
    local r; read -r -p "Continuar? [s/N] " r
    resposta_sim "$r" || die "Cancelado. Nada foi alterado."
  fi

  passo_pacotes
  passo_atualizacoes
  passo_fail2ban
  passo_firewall
  passo_swap
  passo_docker_no_boot
  passo_relogio
  passo_ssh_so_chave
  resumo_final
}

# PREPARAR_LIB=1 carrega só as funções (o teste); sem ele, executa.
if [ -z "${PREPARAR_LIB:-}" ]; then main "$@"; fi
