#!/usr/bin/env bash
# Prova do instalador remoto (`hostgator-setup-kit/instalar-remoto.sh`).
#
#   bash tests/shell/instalar-remoto.test.sh
#
# ── O que ele guarda ────────────────────────────────────────────────────────
# Este script manda chaves e senhas para um servidor. O pior defeito possível não é "não
# instalou": é VAZAR o segredo (para `ps`, para o histórico, para a tela) ou SOBRESCREVER o
# .env de uma instalação que já existe (perder CPF_ENCRYPTION_KEY = perder dado cifrado).
# Por isso as provas centrais são negativas:
#   - nenhum segredo aparece em NENHUM argumento de comando enviado ao SSH;
#   - nenhum segredo aparece na saída (nem no ensaio);
#   - com .env já existente na VPS, nada é gravado;
#   - nome que não aponta para a VPS não chega a conectar.
#
# Nada aqui toca rede nem máquina: ssh, getent, curl e sleep são dublês.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
# O namespace das imagens vem do `_common.sh` (IMG_NS) e nunca é escrito à mão: o guarda
# `tests/unit/namespace-das-imagens.test.ts` reprova o literal fora dos arquivos permitidos. O dublê do
# ssh o lê da variável exportada (ele roda como outro processo).
IMG_NS_DO_KIT="$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "$KIT_DIR/_common.sh" | head -1)"
[ -n "$IMG_NS_DO_KIT" ] || { echo "não consegui ler IMG_NS de _common.sh"; exit 1; }
export IMG_NS_DO_KIT
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }
tem()    { printf '%s' "$1" | grep -qF -- "$2"; }
naotem() { ! printf '%s' "$1" | grep -qF -- "$2"; }

# Segredos de mentira, fáceis de procurar. Se qualquer um aparecer onde não deve, o teste reprova.
ANON="eyJANONKEY-nunca-na-tela-0123456789"
SVC="eyJSERVICEKEY-nunca-na-tela-0123456789"
DB='postgresql://postgres.abcdefghij:SENHA-DO-BANCO-xyz@aws-0-sa-east-1.pooler.supabase.com:5432/postgres'
IAKEY="sk-or-v1-CHAVE-DA-IA-nunca-na-tela"
SENHA='Senha-Do-Admin-123'
SEGREDOS=("$ANON" "$SVC" "SENHA-DO-BANCO-xyz" "$IAKEY" "$SENHA")

mkdir -p "$WORK/bin"
anota() { cat > "$WORK/bin/$1"; chmod +x "$WORK/bin/$1"; }
export ARGV_LOG="$WORK/ssh-argv.log" STDIN_DIR="$WORK/stdin"
mkdir -p "$STDIN_DIR"
echo "chave-falsa" > "$WORK/chave"

# ssh: anota os ARGUMENTOS (é onde um segredo nunca pode estar) e guarda o que veio pela entrada
# padrão. As respostas dependem do comando remoto, como numa VPS de verdade.
anota ssh <<'STUB'
#!/usr/bin/env bash
cmd="${*: -1}"
printf 'ssh %s\n' "$*" >> "$ARGV_LOG"
n=$(ls "$STDIN_DIR" | wc -l)
if [ ! -t 0 ]; then cat > "$STDIN_DIR/$n"; fi
case "$cmd" in
  true)                       exit 0;;
  "test -f "*compose*)        exit "${STUB_COMPOSE_RC:-0}";;
  # O caminho chega entre aspas simples (é assim que o script monta o comando remoto).
  "test -e "*"/.env'")        exit "${STUB_ENV_EXISTE_RC:-1}";;
  "tail -n +"*)               [ -n "${STUB_TAIL_FALHA:-}" ] && exit 255; cat "${STUB_TAIL_ARQ}"; exit 0;;
  "sed -n "*APP_IMAGE*)       printf '%s/elevcrm:%s
' "$IMG_NS_DO_KIT" "${STUB_APP_TAG:-1.18.0}"; exit 0;;
  *)                          exit "${STUB_SSH_RC:-0}";;
esac
STUB

anota getent <<'STUB'
#!/usr/bin/env bash
for ip in ${STUB_IPS:-187.41.96.57}; do echo "$ip STREAM $2"; done
STUB

anota curl <<'STUB'
#!/usr/bin/env bash
# GHCR: o token vem como JSON e o manifest como código HTTP (é assim que o _common.sh pergunta).
case "$*" in
  *ghcr.io/token*) printf '{"token":"duble"}';;
  *ghcr.io/v2*)    printf '%s' "${STUB_GHCR:-200}";;
  *)               printf '%s' "${STUB_HTTP:-200}";;
esac
STUB

anota sleep <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

printf 'Instalando...\n✓ pronto\n__RC=0\n' > "$WORK/tail-ok"
printf 'Instalando...\n✖ deu ruim\n__RC=1\n' > "$WORK/tail-erro"

# Entradas na ordem em que o script pergunta (Enter vazio = pula o opcional).
entradas() { # entradas <senha> <senha repetida>
  printf '%s\n' "https://abcdefghij.supabase.co" "$ANON" "$SVC" "$DB" "1" "$IAKEY" "" \
    "admin@elev.test" "$1" "$2" "" ""
}

roda() { # roda <entradas...> -- <args...>   (saída em $OUT, código em $RC)
  : > "$ARGV_LOG"; rm -rf "$STDIN_DIR"; mkdir -p "$STDIN_DIR"
  OUT="$(entradas "${ENTRADA_SENHA:-$SENHA}" "${ENTRADA_SENHA2:-$SENHA}" | PATH="$WORK/bin:$PATH" bash "$KIT_DIR/instalar-remoto.sh" "$@" 2>&1)"; RC=$?
}
BASE=(--host 187.41.96.57 --chave "$WORK/chave" --dominio crm.elev.test)
ARGV() { cat "$ARGV_LOG"; }
env_enviado() { grep -l 'DOMAIN=' "$STDIN_DIR"/* 2>/dev/null | head -1; }
nenhum_segredo_em() { local texto="$1" s; for s in "${SEGREDOS[@]}"; do tem "$texto" "$s" && return 1; done; return 0; }

echo "== ensaio: valida e mostra, sem conectar"
export STUB_TAIL_ARQ="$WORK/tail-ok"
roda "${BASE[@]}" --ensaio
check "termina com sucesso" test "$RC" -eq 0
check "NÃO chama o ssh nenhuma vez" test ! -s "$ARGV_LOG"
check "mostra o domínio e o e-mail do admin em claro" bash -c '[[ "$1" == *"crm.elev.test"* && "$1" == *"admin@elev.test"* ]]' _ "$OUT"
check "NENHUM segredo aparece na saída" nenhum_segredo_em "$OUT"
check "mostra que fecha o cadastro" tem "$OUT" 'CADASTRO_PUBLICO'
check "mostra o cadastro fechado (false), não aberto" bash -c '[[ "$1" == *"CADASTRO_PUBLICO"*"false"* ]]' _ "$OUT"
check "telemetria desligada por padrão (off)" bash -c '[[ "$1" == *"SENTRY_DSN"*"off"* ]]' _ "$OUT"

echo "== o nome tem de apontar para a VPS"
STUB_IPS=" " roda "${BASE[@]}"
check "nome sem registro: recusa" test "$RC" -ne 0
check "…e explica o registro A" tem "$OUT" "registro A"
check "…sem conectar na VPS" test ! -s "$ARGV_LOG"
STUB_IPS="10.9.9.9" roda "${BASE[@]}"
check "nome apontando para OUTRO IP: recusa" test "$RC" -ne 0
check "…e diz para onde ele aponta" tem "$OUT" "10.9.9.9"
check "…sem conectar na VPS" test ! -s "$ARGV_LOG"

echo "== nunca sobrescreve um .env que já existe"
STUB_ENV_EXISTE_RC=0 roda "${BASE[@]}"
check "recusa" test "$RC" -ne 0
check "explica o porquê (chaves que cifram dados)" tem "$OUT" "cifram dados"
check "nada foi gravado: nenhuma entrada padrão com o .env" test -z "$(env_enviado)"
check "nem o install.sh foi iniciado" bash -c '! grep -q "install.sh" "$1"' _ "$ARGV_LOG"

echo "== instalação completa (dublês)"
roda "${BASE[@]}"
check "termina com sucesso" test "$RC" -eq 0
ENVF="$(env_enviado)"
check "o .env foi enviado pela ENTRADA PADRÃO" test -n "$ENVF"
check "o .env leva o domínio" grep -q '^DOMAIN="crm.elev.test"$' "$ENVF"
check "o .env leva CADASTRO_PUBLICO=false (instalação de vários clientes)" grep -q '^CADASTRO_PUBLICO="false"$' "$ENVF"
check "o .env liga a telemetria em off" grep -q '^SENTRY_DSN="off"$' "$ENVF"
check "o .env leva a chave da IA no nome certo (OpenRouter)" grep -q '^OPENROUTER_API_KEY="sk-or-v1-CHAVE-DA-IA-nunca-na-tela"$' "$ENVF"
check "o .env leva o admin" grep -q '^OWNER_EMAIL="admin@elev.test"$' "$ENVF"
check "NENHUM segredo em NENHUM argumento enviado ao ssh" nenhum_segredo_em "$(ARGV)"
check "NENHUM segredo na saída" nenhum_segredo_em "$OUT"
check "grava com umask 077 e permissão 600" bash -c 'grep -q "umask 077" "$1" && grep -q "chmod 600" "$1"' _ "$ARGV_LOG"
check "roda o install.sh --yes na VPS" bash -c 'grep -q "ssh .*bash -s" "$1" && grep -q "install.sh --yes" "$STDIN_DIR"/*' _ "$ARGV_LOG"
check "apaga OWNER_PASSWORD do .env da VPS depois (e só depois do install.sh)" bash -c '
  a=$(grep -n "bash -s" "$1" | head -1 | cut -d: -f1); b=$(grep -n "OWNER_PASSWORD=/d" "$1" | head -1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$b" -gt "$a" ]' _ "$ARGV_LOG"
check "avisa que falta configurar o Site URL no Supabase" tem "$OUT" "Site URL"
check "entrega o link de acesso" tem "$OUT" "https://crm.elev.test"

echo "== opções"
roda "${BASE[@]}" --manter-senha-do-dono
check "--manter-senha-do-dono: não apaga OWNER_PASSWORD" bash -c '! grep -q "OWNER_PASSWORD" "$1"' _ "$ARGV_LOG"
roda "${BASE[@]}" --cadastro-aberto
check "--cadastro-aberto: o .env leva true" grep -q '^CADASTRO_PUBLICO="true"$' "$(env_enviado)"
roda "${BASE[@]}" --versao v1.18.0
check "--versao: leva o kit para a tag antes de instalar" bash -c 'grep -q "git checkout --quiet .v1.18.0." "$1"' _ "$ARGV_LOG"
roda "${BASE[@]}" --versao "v1.18.0; rm -rf /"
check "--versao com injeção de comando: recusa sem conectar" bash -c '[ "$1" -ne 0 ] && [ ! -s "$2" ]' _ "$RC" "$ARGV_LOG"
roda "${BASE[@]}" --pasta "/opt/x; rm -rf /"
check "--pasta com injeção de comando: recusa sem conectar" bash -c '[ "$1" -ne 0 ] && [ ! -s "$2" ]' _ "$RC" "$ARGV_LOG"
roda "${BASE[@]}" --dominio "https://crm.elev.test/"
check "--dominio com https:// e barra: recusa" test "$RC" -ne 0

echo "== caracteres especiais não quebram nem escapam do .env"
ENTRADA_SENHA='Ab"c$d`e\f-12345' ENTRADA_SENHA2='Ab"c$d`e\f-12345' roda "${BASE[@]}"
ENVF="$(env_enviado)"
check "senha com aspas, \$, crase e barra sai ESCAPADA" grep -qF 'OWNER_PASSWORD="Ab\"c\$d\`e\\f-12345"' "$ENVF"
check "e o .env continua tendo UMA linha por variável" test "$(grep -c '^OWNER_PASSWORD=' "$ENVF")" -eq 1

echo "== a versão pedida tem de existir INTEIRA, e ser a que ficou"
STUB_GHCR=404 roda "${BASE[@]}" --versao v1.18.0
check "imagens da versão não publicadas: recusa" test "$RC" -ne 0
check "…explica o motivo" tem "$OUT" "três imagens"
check "…ANTES de pedir qualquer chave e sem conectar na VPS" bash -c '[ ! -s "$1" ] && [[ "$2" != *"Supabase"* ]]' _ "$ARGV_LOG" "$OUT"
STUB_GHCR=404 roda "${BASE[@]}" --versao v1.18.0 --ensaio
check "no --ensaio a conferência na rede não acontece (nada é conectado)" test "$RC" -eq 0
STUB_GHCR=200 roda "${BASE[@]}" --versao v1.18.0
check "imagens publicadas: segue" test "$RC" -eq 0
check "…e confirma que o app instalado é a 1.18.0" tem "$OUT" "o app instalado é a 1.18.0"
STUB_APP_TAG=1.17.0 roda "${BASE[@]}" --versao v1.18.0
check "instalou OUTRA versão que a pedida: recusa em voz alta" test "$RC" -ne 0
check "…avisa que o cadastro pode estar aberto" tem "$OUT" "ABERTO"

echo "== campo sem eco: dá sinal de que recebeu, e recusa a colagem repetida"
roda "${BASE[@]}" --ensaio
check "mostra o TAMANHO recebido de cada segredo" tem "$OUT" "recebido: ${#ANON} caracteres"
check "…e só o tamanho: nenhum segredo na saída" nenhum_segredo_em "$OUT"
ANON="$ANON$ANON$ANON$ANON" roda "${BASE[@]}"
check "a MESMA chave colada 4 vezes: recusa, sem conectar" bash -c '[ "$1" -ne 0 ] && [ ! -s "$2" ]' _ "$RC" "$ARGV_LOG"
check "…diz quantas vezes e quanto o certo teria" bash -c '[[ "$1" == *"4 vezes"* && "$1" == *"o certo teria ${2}"* ]]' _ "$OUT" "${#ANON}"
check "…sem imprimir a chave" nenhum_segredo_em "$OUT"
IAKEY_ORIGINAL="$IAKEY"
IAKEY="$IAKEY$IAKEY" roda "${BASE[@]}"
check "a chave da IA colada 2 vezes também é recusada" bash -c '[ "$1" -ne 0 ] && [ ! -s "$2" ]' _ "$RC" "$ARGV_LOG"
IAKEY="$IAKEY_ORIGINAL"
SENHA_LONGA='abcdefghijkl-mnopqrstuv-0123'
ENTRADA_SENHA="$SENHA_LONGA" ENTRADA_SENHA2="$SENHA_LONGA" roda "${BASE[@]}" --ensaio
check "uma senha comum, sem repetição, NÃO é confundida com colagem repetida" test "$RC" -eq 0

echo "== entradas inválidas"
DB_ORIGINAL="$DB"
DB='postgresql://postgres.abcdefghij:[YOUR-PASSWORD]@aws-0-sa-east-1.pooler.supabase.com:5432/postgres' roda "${BASE[@]}"
check "connection string com [YOUR-PASSWORD]: recusa, sem conectar" bash -c '[ "$1" -ne 0 ] && [ ! -s "$2" ]' _ "$RC" "$ARGV_LOG"
check "…e diz o que fazer" tem "$OUT" "YOUR-PASSWORD"
DB='postgresql://postgres:senha@db.abcdefghij.supabase.co:5432/postgres' roda "${BASE[@]}"
check "Direct connection (só IPv6): recusa, sem conectar" bash -c '[ "$1" -ne 0 ] && [ ! -s "$2" ]' _ "$RC" "$ARGV_LOG"
DB="$DB_ORIGINAL"
ENTRADA_SENHA='curta' ENTRADA_SENHA2='curta' roda "${BASE[@]}"
check "senha curta (<12) é recusada, sem conectar" bash -c '[ "$1" -ne 0 ] && [ ! -s "$2" ]' _ "$RC" "$ARGV_LOG"
ENTRADA_SENHA="$SENHA" ENTRADA_SENHA2='Outra-Senha-1234' roda "${BASE[@]}"
check "senhas diferentes: recusa, sem conectar" bash -c '[ "$1" -ne 0 ] && [ ! -s "$2" ]' _ "$RC" "$ARGV_LOG"
check "…e não imprime nenhuma das senhas" nenhum_segredo_em "$OUT"

echo "== falhas no caminho"
STUB_COMPOSE_RC=1 roda "${BASE[@]}"
check "kit ausente na VPS: recusa antes de enviar segredos" bash -c '[ "$1" -ne 0 ] && [ -z "$(grep -l DOMAIN= "$2"/* 2>/dev/null)" ]' _ "$RC" "$STDIN_DIR"
STUB_TAIL_ARQ="$WORK/tail-erro" roda "${BASE[@]}"
check "install.sh com erro: o script falha" test "$RC" -ne 0
check "…aponta o log na VPS" tem "$OUT" "/var/log/elevcrm-install.log"
check "…e NÃO apaga OWNER_PASSWORD (a instalação pode precisar repetir)" bash -c '! grep -q "OWNER_PASSWORD" "$1"' _ "$ARGV_LOG"
STUB_HTTP=502 roda "${BASE[@]}"
check "HTTPS ainda não responde 200: avisa, sem mentir que está no ar" tem "$OUT" "ainda não respondeu 200"

echo
if [ "$FAILS" -eq 0 ]; then echo "instalar-remoto: tudo certo"; else echo "instalar-remoto: $FAILS falha(s)"; fi
exit "$FAILS"
