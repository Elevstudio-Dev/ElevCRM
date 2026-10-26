#!/usr/bin/env bash
# Prova da preparação do servidor (`hostgator-setup-kit/preparar-host.sh`).
#
#   bash tests/shell/preparar-host.test.sh
#
# ── O que ele guarda ────────────────────────────────────────────────────────
# Este script mexe no firewall de uma máquina que o dono acessa pela rede. O pior
# defeito possível não é "não protegeu": é "trancou o dono para fora" — e isso
# acontece de duas formas que têm teste aqui: ligar o ufw ANTES de liberar a porta
# do SSH, e ligar o ufw sem saber qual é a porta do SSH. As demais provas (nada
# muda em --dry-run, idempotência, a chave antes da senha) cercam o mesmo medo:
# um script de "endurecimento" que deixa o servidor pior.
#
# Nada aqui toca a máquina de quem roda: todo comando do sistema é um dublê que só
# anota a chamada, e os arquivos de /etc vão para uma pasta temporária
# (PREPARAR_RAIZ).
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
# linha (1-based) em que o log registra o comando, ou vazio
linha_de() { grep -nF -- "$1" "$LOG" | head -1 | cut -d: -f1; }

# ── Dublês: cada um anota "<nome> <args>" em $STUB_LOG ───────────────────────
mkdir -p "$WORK/bin"
anota() { cat > "$WORK/bin/$1"; chmod +x "$WORK/bin/$1"; }

for cmd in apt-get ufw mkswap sysctl fail2ban-client; do
  anota "$cmd" <<STUB
#!/usr/bin/env bash
echo "$cmd \$*" >> "\$STUB_LOG"
exit 0
STUB
done

anota dpkg <<'STUB'
#!/usr/bin/env bash
# dpkg -s <pacote>: instalado se estiver em STUB_INSTALADOS
for p in ${STUB_INSTALADOS:-}; do [ "$p" = "$2" ] && exit 0; done
exit 1
STUB

anota systemctl <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
case "$1" in is-enabled) exit "${STUB_DOCKER_HABILITADO_RC:-1}" ;; esac
exit 0
STUB

anota swapon <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "--show" ]; then printf '%s' "${STUB_SWAPON:-}"; exit 0; fi
echo "swapon $*" >> "$STUB_LOG"
STUB

anota fallocate <<'STUB'
#!/usr/bin/env bash
echo "fallocate $*" >> "$STUB_LOG"
[ "${STUB_FALLOCATE_RC:-0}" -eq 0 ] && : > "${@: -1}"
exit "${STUB_FALLOCATE_RC:-0}"
STUB

anota dd <<'STUB'
#!/usr/bin/env bash
echo "dd $*" >> "$STUB_LOG"
for a in "$@"; do case "$a" in of=*) : > "${a#of=}";; esac; done
STUB

anota timedatectl <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "show" ]; then printf '%s\n' "${STUB_NTP:-no}"; exit 0; fi
echo "timedatectl $*" >> "$STUB_LOG"
STUB

anota sshd <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  -T) for p in ${STUB_SSHD_PORTAS:-}; do echo "port $p"; done ;;
  -t) echo "sshd -t" >> "$STUB_LOG"; exit "${STUB_SSHD_T_RC:-0}" ;;
esac
STUB

anota ss <<'STUB'
#!/usr/bin/env bash
printf '%s' "${STUB_SS:-}"
STUB

anota df <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1K-blocks Used Available Use%% Mounted\n/dev/vda1 100 50 %s 50%% /\n' "${STUB_DF_KB:-20000000}"
STUB

anota docker <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

PATH="$WORK/bin:$PATH"

# ── Cada caso nasce de uma raiz limpa ────────────────────────────────────────
nova_raiz() {
  R="$WORK/raiz-$1"; LOG="$R/stub.log"
  mkdir -p "$R/etc" "$R/home/.ssh" "$R/root/.ssh"
  : > "$LOG"
  printf 'MemTotal:       %s kB\n' "${RAM_KB:-4000000}" > "$R/meminfo"
  : > "$R/etc/fstab"
}

prep() {  # prep [args...] → OUT e RC
  RC=0
  OUT="$(env PREPARAR_RAIZ="$R" PREPARAR_UID="${UID_FALSO:-0}" HOME="$R/home" \
    PREPARAR_MEMINFO="$R/meminfo" STUB_LOG="$LOG" \
    SSH_CONNECTION="${SSH_CONNECTION_FALSA-1.1.1.1 50000 2.2.2.2 2222}" \
    bash "$KIT_DIR/preparar-host.sh" "$@" 2>&1)" || RC=$?
}
export STUB_SSHD_PORTAS="22"

# ══ --dry-run: o plano é visível e NADA muda ═════════════════════════════════
echo "--dry-run"
nova_raiz dry
UID_FALSO=1000 prep --dry-run
check "roda sem ser root e sai 0" test "$RC" -eq 0
check "mostra o plano do firewall (a linha do dry-run NÃO some)" tem "$OUT" "[dry-run] ufw --force enable"
check "nenhum pacote instalado de verdade" naotem "$(cat "$LOG")" "apt-get install"
check "o firewall NÃO foi ligado de verdade" naotem "$(cat "$LOG")" "ufw --force enable"
check "nenhum arquivo foi criado em /etc" test -z "$(find "$R/etc" -type f ! -name fstab)"
check "nenhum swap foi criado" test ! -e "$R/swapfile"
check "diz que nada foi alterado" tem "$OUT" "Nada foi alterado"

# ══ Precisa ser root para valer ══════════════════════════════════════════════
echo "permissão"
nova_raiz root
UID_FALSO=1000 prep --yes
check "sem root e sem --dry-run: recusa" test "$RC" -ne 0
check "  e diz como proceder" tem "$OUT" "Rode como root"
check "  sem executar nada" test ! -s "$LOG"

# ══ A porta do SSH ═══════════════════════════════════════════════════════════
echo "porta do SSH"
portas() {  # portas [VAR=valor...] -- [portas extras]   → as portas que o script liberaria
  local envs=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  env "${envs[@]}" PREPARAR_LIB=1 PREPARAR_RAIZ="$R" STUB_LOG="$LOG"     bash -c '. "$0"/preparar-host.sh 2>/dev/null; set +e; PORTAS_EXTRAS=("$@"); portas_ssh | paste -sd" " -' "$KIT_DIR" "$@"
}
nova_raiz portas
p="$(portas SSH_CONNECTION="1.1.1.1 50000 2.2.2.2 2222" STUB_SSHD_PORTAS=22 STUB_SS= --)"
check "junta a porta da conexão atual com a do sshd, sem repetir" test "$p" = "22 2222"
p="$(portas SSH_CONNECTION= STUB_SSHD_PORTAS= STUB_SS=$'LISTEN 0 128 0.0.0.0:22022 0.0.0.0:* users:(("sshd",pid=1,fd=3))
' --)"
check "porta custom (22022) achada pelo ss, sem SSH_CONNECTION nem sshd -T" test "$p" = "22022"
p="$(portas SSH_CONNECTION= STUB_SSHD_PORTAS=22 STUB_SS= -- 2200)"
check "--porta-ssh acrescenta" test "$p" = "22 2200"
p="$(portas SSH_CONNECTION= STUB_SSHD_PORTAS= STUB_SS= --)"
check "sem nenhuma fonte: lista vazia (e o passo seguinte recusa)" test -z "$p"

# O passo do firewall tem a PRÓPRIA guarda, independente do fail2ban (que roda antes e
# também recusa). Se alguém reordenar os passos, esta é a última barreira antes do
# `ufw enable` — por isso é testada isolada, e não só pela rodada completa.
nova_raiz fwsozinho
saida_fw="$(env PREPARAR_LIB=1 PREPARAR_RAIZ="$R" STUB_LOG="$LOG" SSH_CONNECTION= STUB_SSHD_PORTAS= STUB_SS= \
  bash -c '. "$0"/preparar-host.sh 2>/dev/null; set +e; passo_firewall; echo "rc=$?"' "$KIT_DIR" 2>&1)"
check "passo_firewall sozinho, sem porta de SSH: recusa" tem "$saida_fw" "não vou ligar o firewall às cegas"
check "  e não liga o firewall" naotem "$(cat "$LOG")" "ufw --force enable"

nova_raiz semporta
STUB_SSHD_PORTAS="" SSH_CONNECTION_FALSA="" prep --yes
check "sem descobrir a porta do SSH: recusa" test "$RC" -ne 0
check "  diz o motivo" tem "$OUT" "porta do SSH"
check "  e o firewall NÃO foi ligado" naotem "$(cat "$LOG")" "ufw --force enable"

# ══ Firewall: o SSH entra ANTES do enable ════════════════════════════════════
echo "firewall"
nova_raiz fw
STUB_SSHD_PORTAS="22" prep --yes
check "a rodada completa sai 0" test "$RC" -eq 0
ssh_l="$(linha_de 'ufw allow 2222/tcp')"; ssh22_l="$(linha_de 'ufw allow 22/tcp')"; en_l="$(linha_de 'ufw --force enable')"
check "libera a porta da conexão atual (2222)" test -n "$ssh_l"
check "libera também a do sshd (22)" test -n "$ssh22_l"
check "libera 80 e 443" test -n "$(linha_de 'ufw allow 80/tcp')" -a -n "$(linha_de 'ufw allow 443/tcp')"
check "o enable vem DEPOIS de liberar o SSH (a ordem é o ponto)" test -n "$en_l" -a "$ssh_l" -lt "$en_l" -a "$ssh22_l" -lt "$en_l"
check "política padrão: nega o que entra" test -n "$(linha_de 'ufw default deny incoming')"

# ══ fail2ban e atualizações ══════════════════════════════════════════════════
echo "fail2ban e atualizações automáticas"
check "o jail do SSH usa as portas certas" grep -q 'port     = 22,2222' "$R/etc/fail2ban/jail.d/elevcrm.local"
check "  e está ligado" grep -q 'enabled  = true' "$R/etc/fail2ban/jail.d/elevcrm.local"
check "atualizações de segurança automáticas ligadas" grep -q 'Unattended-Upgrade "1"' "$R/etc/apt/apt.conf.d/20auto-upgrades"
check "reinício automático DESLIGADO" grep -q 'Automatic-Reboot "false"' "$R/etc/apt/apt.conf.d/52elevcrm-unattended"
check "instala os pacotes que faltam" tem "$(cat "$LOG")" "apt-get install"
check "o age (do backup cifrado) está entre os pacotes" tem "$(cat "$LOG")" " age "

nova_raiz tudoinstalado
STUB_INSTALADOS="ufw fail2ban unattended-upgrades age cron curl ca-certificates openssl" prep --yes
check "com tudo instalado: não chama apt-get install" naotem "$(cat "$LOG")" "apt-get install"

# ══ Swap ═════════════════════════════════════════════════════════════════════
echo "swap"
nova_raiz swap4
prep --yes
check "4 GB sem swap: cria 2G" tem "$(cat "$LOG")" "fallocate -l 2G"
check "  formata e ativa" test -n "$(linha_de 'mkswap')" -a -n "$(linha_de 'swapon')"
check "  persiste no fstab" grep -q 'swapfile none swap sw 0 0' "$R/etc/fstab"
check "  com permissão 600 (swap legível por todos vaza memória)" test "$(stat -c %a "$R/swapfile")" = "600"
check "  e baixa o swappiness" grep -q 'vm.swappiness = 10' "$R/etc/sysctl.d/99-elevcrm.conf"

STUB_SWAPON="/swapfile file 2G 0B -2" prep --yes
check "já com swap ativo: não cria outro" test "$(grep -c 'fallocate' "$LOG")" -eq 1
check "  e o fstab não duplica" test "$(grep -c 'swap sw' "$R/etc/fstab")" -eq 1

# A linha do swap JÁ está no fstab e o swap não está ativo (ex.: a rodada anterior caiu
# entre gravar o fstab e ligar o swap). Chega-se ao código que mexe no fstab — o caso
# acima sempre saía cedo em "já há swap" — e ele não pode acrescentar uma segunda linha.
nova_raiz swapfstab
echo '/swapfile none swap sw 0 0' > "$R/etc/fstab"
STUB_SWAPON="" prep --yes
check "linha de swap já no fstab (swap inativo): chega a criar o swap" tem "$(cat "$LOG")" "fallocate -l 2G"
check "  e NÃO duplica a linha do fstab" test "$(grep -c 'swap sw' "$R/etc/fstab")" -eq 1

RAM_KB=16000000 nova_raiz swap16
prep --yes
check "16 GB: sem swap" naotem "$(cat "$LOG")" "fallocate"

nova_raiz swapoff
prep --yes --sem-swap
check "--sem-swap respeitado" naotem "$(cat "$LOG")" "fallocate"

nova_raiz swapdisco
STUB_DF_KB=1000000 prep --yes
check "pouco disco livre: não cria swap" naotem "$(cat "$LOG")" "fallocate"
check "  e avisa" tem "$OUT" "pouco espaço livre"

nova_raiz swapdd
STUB_FALLOCATE_RC=1 prep --yes
check "sem fallocate: cai para dd" tem "$(cat "$LOG")" "dd if=/dev/zero"

# ══ Idempotência ═════════════════════════════════════════════════════════════
echo "idempotência"
nova_raiz idem
STUB_SWAPON="" prep --yes
antes="$(cd "$R/etc" && find . -type f | sort | xargs sha256sum)"
STUB_SWAPON="/swapfile file 2G 0B -2" STUB_NTP=yes STUB_INSTALADOS="ufw fail2ban unattended-upgrades age cron curl ca-certificates openssl" prep --yes
depois="$(cd "$R/etc" && find . -type f | sort | xargs sha256sum)"
check "rodar de novo não muda nenhum arquivo" test "$antes" = "$depois"
check "  e diz o que já estava certo" tem "$OUT" "já estava"

# ══ --ssh-so-chave ═══════════════════════════════════════════════════════════
echo "SSH só com chave"
nova_raiz semchave
prep --yes --ssh-so-chave
check "sem nenhuma chave autorizada: recusa" test "$RC" -ne 0
check "  explica que trancaria o dono" tem "$OUT" "trancaria você para fora"
check "  e não grava a configuração" test ! -e "$R/etc/ssh/sshd_config.d/99-elevcrm.conf"

nova_raiz comchave
echo "ssh-ed25519 AAAAexemplo dono@maquina" > "$R/root/.ssh/authorized_keys"
prep --yes --ssh-so-chave
check "com chave: grava PasswordAuthentication no" grep -q 'PasswordAuthentication no' "$R/etc/ssh/sshd_config.d/99-elevcrm.conf"
check "  valida (sshd -t) ANTES de recarregar" test -n "$(linha_de 'sshd -t')" -a -n "$(linha_de 'systemctl reload ssh')" -a "$(linha_de 'sshd -t')" -lt "$(linha_de 'systemctl reload ssh')"
check "  e manda abrir outra janela antes de fechar esta" tem "$OUT" "abra outra janela"

nova_raiz sshdruim
echo "ssh-ed25519 AAAAexemplo dono@maquina" > "$R/root/.ssh/authorized_keys"
STUB_SSHD_T_RC=1 prep --yes --ssh-so-chave
check "sshd recusa a configuração: o script desfaz" test ! -e "$R/etc/ssh/sshd_config.d/99-elevcrm.conf"
check "  e NÃO recarrega o sshd" naotem "$(cat "$LOG")" "systemctl reload ssh"
check "  e sai com erro" test "$RC" -ne 0

nova_raiz semflag
echo "ssh-ed25519 AAAAexemplo dono@maquina" > "$R/root/.ssh/authorized_keys"
prep --yes
check "sem a flag, o SSH por senha NÃO é tocado" test ! -e "$R/etc/ssh/sshd_config.d/99-elevcrm.conf"

# ══ Opções inválidas ═════════════════════════════════════════════════════════
echo "opções"
nova_raiz opcao
prep --yes --porta-ssh abc
check "--porta-ssh não numérico é recusado" test "$RC" -ne 0
prep --opcao-que-nao-existe
check "opção desconhecida é recusada" test "$RC" -ne 0

echo
if [ "$FAILS" -eq 0 ]; then echo "preparar-host: tudo verde"; exit 0; fi
echo "preparar-host: $FAILS falha(s)"; exit 1
