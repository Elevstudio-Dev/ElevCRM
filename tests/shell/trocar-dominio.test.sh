#!/usr/bin/env bash
# Prova do `hostgator-setup-kit/trocar-dominio.sh`.
#
#   bash tests/shell/trocar-dominio.test.sh
#
# ── O que ele guarda ────────────────────────────────────────────────────────
# Trocar o domínio de um CRM que está no ar tem dois modos de falha graves, e nenhum deles é "o
# comando deu erro":
#   - o site CAI e fica caído (certificado que não emitiu, DNS que ainda não apontava, app que não
#     subiu no nome novo) — por isso as provas centrais são de REVERSÃO: em toda falha o `.env` volta
#     BYTE A BYTE ao de antes e os contêineres são recriados no endereço antigo;
#   - um segredo vaza para a tela — o cron que o script reescreve carrega o segredo interno.
#
# Nada aqui toca rede nem máquina: docker, getent, curl, crontab e sleep são dublês.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
# O namespace das imagens vem do `_common.sh` (IMG_NS) e nunca é escrito à mão: o guarda
# `tests/unit/namespace-das-imagens.test.ts` reprova o literal fora dos arquivos permitidos.
IMG_NS_DO_KIT="$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "$KIT_DIR/_common.sh" | head -1)"
[ -n "$IMG_NS_DO_KIT" ] || { echo "não consegui ler IMG_NS de _common.sh"; exit 1; }
IMAGEM_DO_TESTE="${IMG_NS_DO_KIT}/elevcrm:1.18.0"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }
tem()    { printf '%s' "$1" | grep -qF -- "$2"; }
naotem() { ! printf '%s' "$1" | grep -qF -- "$2"; }

CRON_SEG="SEGREDO-DO-CRON-nunca-na-tela"
INT_SEG="SEGREDO-INTERNO-nunca-na-tela"
SVC_SEG="sb_secret_NUNCA-NA-TELA"
SEGREDOS=("$CRON_SEG" "$INT_SEG" "$SVC_SEG")
nenhum_segredo_em() { local s; for s in "${SEGREDOS[@]}"; do tem "$1" "$s" && return 1; done; return 0; }

mkdir -p "$WORK/bin"
anota() { cat > "$WORK/bin/$1"; chmod +x "$WORK/bin/$1"; }
export DOCKER_LOG="$WORK/docker.log" CURL_LOG="$WORK/curl.log" CRONTAB_FILE="$WORK/crontab"

anota docker <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *" up "*) exit "${STUB_UP_RC:-0}";;
  *" exec "*) printf '%s\n{"data":{"status":"%s"}}\n' "${STUB_HEALTH:-healthy}" "${STUB_HEALTH:-healthy}"; exit 0;;
esac
exit 0
STUB

# getent: A-records em STUB_IPS (vazio = nome que não resolve). Sem AAAA, devolve o IPv4 "mapeado"
# (::ffff:) — é o que o getent faz de verdade, e o script não pode tomá-lo por um IPv6 estranho.
anota getent <<'STUB'
#!/usr/bin/env bash
case "$1" in
  ahostsv4) for ip in ${STUB_IPS-187.41.96.57}; do echo "$ip STREAM $2"; done;;
  ahostsv6)
    if [ -n "${STUB_AAAA:-}" ]; then for ip in $STUB_AAAA; do echo "$ip STREAM $2"; done
    else for ip in ${STUB_IPS-187.41.96.57}; do echo "::ffff:$ip STREAM $2"; done; fi;;
esac
exit 0
STUB

anota curl <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$CURL_LOG"
case "$*" in
  *api.ipify.org*) printf '%s' "${STUB_IP-187.41.96.57}"; exit 0;;
  *"/login"*)
    code="${STUB_LOGIN_CODE:-200}"
    printf '%s' "$code"
    [ "$code" = "200" ] && exit 0 || exit 35;;
esac
exit 0
STUB

# `crontab -` lê a entrada INTEIRA antes de instalar. O dublê tem de fazer igual: gravar com
# `cat > arquivo` truncava o arquivo enquanto o `crontab -l` do outro lado do pipe ainda lia dele
# (os dois começam juntos) e a prova reprovava um script correto.
anota crontab <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  -l) [ -f "$CRONTAB_FILE" ] || { echo "no crontab for root" >&2; exit 1; }; cat "$CRONTAB_FILE";;
  -)  novo="$(cat)"; printf '%s\n' "$novo" > "$CRONTAB_FILE";;
esac
STUB

anota sleep <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

PROJ="$WORK/proj"
ENV_ORIGINAL="$WORK/env.original"

# Estado de uma instalação que já está no ar no endereço velho.
novo_cenario() {
  rm -rf "$PROJ" "$DOCKER_LOG" "$CURL_LOG" "$CRONTAB_FILE"
  mkdir -p "$PROJ"
  : > "$PROJ/docker-compose.prod.yml"
  cat > "$PROJ/.env" <<ENV
DOMAIN="velho.hstgr.cloud"
NEXT_PUBLIC_APP_URL="https://velho.hstgr.cloud"
NEXT_PUBLIC_ADMIN_URL="https://velho.hstgr.cloud"
ACME_EMAIL="ops@elev.test"
INTERNAL_CRON_SECRET="$CRON_SEG"
INTERNAL_SECRET="$INT_SEG"
SUPABASE_SERVICE_ROLE_KEY="$SVC_SEG"
OUTRA_URL="https://velho.hstgr.cloud/gancho"
APP_IMAGE=$IMAGEM_DO_TESTE
ENV
  chmod 600 "$PROJ/.env"
  cp -p "$PROJ/.env" "$ENV_ORIGINAL"
  local base; base="$(cd "$PROJ" && pwd)"
  cat > "$CRONTAB_FILE" <<CRON
* * * * * curl -fsS -H "Authorization: Bearer $CRON_SEG" "https://velho.hstgr.cloud/api/v1/cron/event-log-drain" >/dev/null 2>&1 # elevcrm:$base:drain
*/5 * * * * cd $base && bash hostgator-setup-kit/agent.sh >/dev/null 2>&1 # elevcrm:$base:agent
CRON
  cp "$CRONTAB_FILE" "$WORK/crontab.original"
  : > "$DOCKER_LOG"; : > "$CURL_LOG"
}

rodar() {
  OUT="$(cd "$PROJ" && PATH="$WORK/bin:$PATH" bash "$KIT_DIR/trocar-dominio.sh" "$@" 2>&1)"
  RC=$?
}

env_igual_ao_original()   { cmp -s "$PROJ/.env" "$ENV_ORIGINAL"; }
cron_igual_ao_original()  { cmp -s "$CRONTAB_FILE" "$WORK/crontab.original"; }
docker_nao_foi_chamado()  { [ ! -s "$DOCKER_LOG" ]; }
conta_up()                { grep -c ' up -d' "$DOCKER_LOG" || true; }
nada_mudou() { env_igual_ao_original && cron_igual_ao_original && docker_nao_foi_chamado; }

echo "== troca que dá certo"
novo_cenario
rodar --dominio novo.elev.test
check "termina com sucesso" test "$RC" -eq 0
check "DOMAIN agora é o novo" grep -qxF 'DOMAIN="novo.elev.test"' "$PROJ/.env"
check "NEXT_PUBLIC_APP_URL agora é o novo" grep -qxF 'NEXT_PUBLIC_APP_URL="https://novo.elev.test"' "$PROJ/.env"
check "NEXT_PUBLIC_ADMIN_URL agora é o novo" grep -qxF 'NEXT_PUBLIC_ADMIN_URL="https://novo.elev.test"' "$PROJ/.env"
check "o domínio velho não sobrou nas três chaves" bash -c '! grep -E "^(DOMAIN|NEXT_PUBLIC_APP_URL|NEXT_PUBLIC_ADMIN_URL)=.*velho" "$1"' _ "$PROJ/.env"
check "as outras chaves ficam intactas (segredos e imagem)" bash -c 'grep -qxF "INTERNAL_CRON_SECRET=\"$2\"" "$1" && grep -qxF "SUPABASE_SERVICE_ROLE_KEY=\"$3\"" "$1" && grep -qxF "APP_IMAGE=$4" "$1"' _ "$PROJ/.env" "$CRON_SEG" "$SVC_SEG" "$IMAGEM_DO_TESTE"
check "o .env segue com permissão 600" test "$(stat -c %a "$PROJ/.env")" = "600"
check "guarda cópia do .env anterior, igual ao original" bash -c 'c=$(ls "$1"/.env.bak-dominio-* 2>/dev/null | head -1); [ -n "$c" ] && cmp -s "$c" "$2"' _ "$PROJ" "$ENV_ORIGINAL"
check "…com permissão 600 (tem segredo)" bash -c 'c=$(ls "$1"/.env.bak-dominio-* | head -1); [ "$(stat -c %a "$c")" = "600" ]' _ "$PROJ"
check "recria os contêineres uma vez" test "$(conta_up)" -eq 1
check "o cron do drain chama o endereço novo, uma linha só" bash -c '[ "$(grep -c "event-log-drain" "$1")" = 1 ] && grep -q "https://novo.elev.test/api/v1/cron/event-log-drain" "$1" && ! grep -q velho "$1"' _ "$CRONTAB_FILE"
check "…com o mesmo segredo (o cron não pode ficar sem autorização)" grep -qF "Bearer $CRON_SEG" "$CRONTAB_FILE"
check "a linha do agente de atualização é preservada" grep -q 'agent.sh' "$CRONTAB_FILE"
check "o cron guarda o marcador da instalação (uma vez)" bash -c '[ "$(grep -c ":drain" "$1")" = 1 ]' _ "$CRONTAB_FILE"
check "avisa do Supabase (Site URL com o endereço novo)" tem "$OUT" "https://novo.elev.test/auth/confirm"
check "avisa que o endereço antigo deixou de responder" tem "$OUT" "deixou de responder"
check "lista, só pelo NOME, a chave que ainda cita o endereço velho" tem "$OUT" "OUTRA_URL"
check "…e não imprime o valor dela" naotem "$OUT" "gancho"
check "não imprime nenhum segredo" nenhum_segredo_em "$OUT"
check "o docker não recebe segredo em argumento" bash -c '! grep -qE "SEGREDO|sb_secret" "$1"' _ "$DOCKER_LOG"

echo "== idempotência"
CR_DEPOIS="$(cat "$CRONTAB_FILE")"
: > "$DOCKER_LOG"
rodar --dominio novo.elev.test
check "repetir o mesmo domínio não faz nada e termina bem" test "$RC" -eq 0
check "…diz que já usa" tem "$OUT" "já usa"
check "…sem recriar contêiner" docker_nao_foi_chamado
check "…e sem mexer no cron" test "$(cat "$CRONTAB_FILE")" = "$CR_DEPOIS"

echo "== lido da entrada padrão (bash -s): recusa"
novo_cenario
OUT="$(cd "$PROJ" && PATH="$WORK/bin:$PATH" bash -s -- --dominio novo.elev.test < "$KIT_DIR/trocar-dominio.sh" 2>&1)"; RC=$?
check "recusa — o docker exec comeria o resto do script" test "$RC" -ne 0
check "…explica que precisa de um arquivo" tem "$OUT" "ARQUIVO"
check "…sem alterar nada" nada_mudou

echo "== script copiado para FORA do kit (VPS cuja versão ainda não o traz)"
novo_cenario
mkdir -p "$WORK/fora"; cp "$KIT_DIR/trocar-dominio.sh" "$WORK/fora/"
mkdir -p "$PROJ/hostgator-setup-kit"; cp "$KIT_DIR"/*.sh "$PROJ/hostgator-setup-kit/"
OUT="$(cd "$PROJ" && PATH="$WORK/bin:$PATH" bash "$WORK/fora/trocar-dominio.sh" --dominio novo.elev.test 2>&1)"; RC=$?
check "acha o kit da pasta do projeto e troca" test "$RC" -eq 0
check "…o domínio mudou" grep -qxF 'DOMAIN="novo.elev.test"' "$PROJ/.env"

echo "== .env com permissão frouxa (alguém o abriu para leitura)"
novo_cenario
chmod 644 "$PROJ/.env"
rodar --dominio novo.elev.test
check "a cópia sai com 600 mesmo assim (tem segredo; o cp -p herdaria o 644)" bash -c 'c=$(ls "$1"/.env.bak-dominio-* | head -1); [ "$(stat -c %a "$c")" = "600" ]' _ "$PROJ"
check "o .env novo também fica 600" test "$(stat -c %a "$PROJ/.env")" = "600"

echo "== maiúsculas e espaços viram o nome certo"
novo_cenario
rodar --dominio "  NOVO.Elev.Test "
check "aceita e normaliza" grep -qxF 'DOMAIN="novo.elev.test"' "$PROJ/.env"

echo "== ensaio"
novo_cenario
rodar --dominio novo.elev.test --ensaio
check "termina bem" test "$RC" -eq 0
check "descreve a troca" tem "$OUT" "Ensaio"
check "não altera nada (.env, cron, contêineres)" nada_mudou

echo "== o DNS ainda não aponta para a VPS"
novo_cenario
STUB_IPS="203.0.113.9" rodar --dominio novo.elev.test
check "recusa" test "$RC" -ne 0
check "diz qual IP o nome precisa ter" tem "$OUT" "187.41.96.57"
check "não altera nada" nada_mudou
novo_cenario
STUB_IPS="" rodar --dominio novo.elev.test
check "nome que não resolve: recusa" test "$RC" -ne 0
check "…sem alterar nada" nada_mudou
novo_cenario
STUB_IPS="203.0.113.9 187.41.96.57" rodar --dominio novo.elev.test
check "vários A-records, um deles é a VPS: aceita" test "$RC" -eq 0
novo_cenario
STUB_IP="" rodar --dominio novo.elev.test
check "sem descobrir o IP da VPS: recusa (não adivinha)" test "$RC" -ne 0
check "…sem alterar nada" nada_mudou

echo "== AAAA que não é desta VPS"
novo_cenario
STUB_AAAA="2001:db8::1" rodar --dominio novo.elev.test
check "recusa — o Let's Encrypt tentaria o IPv6 primeiro" test "$RC" -ne 0
check "explica o AAAA" tem "$OUT" "AAAA"
check "não altera nada" nada_mudou

echo "== domínio mal formado"
for ruim in "https://novo.elev.test" "novo.elev.test/painel" "semponto" "-novo.elev.test" "novo..elev.test" "novo.elev.test:8080" ""; do
  novo_cenario
  rodar --dominio "$ruim"
  check "recusa '${ruim}' sem tocar em nada" bash -c '[ "$1" -ne 0 ]' _ "$RC"
  check "…nada mudou com '${ruim}'" nada_mudou
done
novo_cenario
rodar
check "sem --dominio: recusa" test "$RC" -ne 0
check "…e mostra o uso" tem "$OUT" "Uso:"
novo_cenario
rodar --dominio novo.elev.test --nao-existe
check "argumento desconhecido: recusa antes de tudo" test "$RC" -ne 0
check "…sem alterar nada" nada_mudou

echo "== URL pública editada à mão"
novo_cenario
sed -i 's#^NEXT_PUBLIC_APP_URL=.*#NEXT_PUBLIC_APP_URL="https://outro.exemplo.com"#' "$PROJ/.env"
cp -p "$PROJ/.env" "$ENV_ORIGINAL"
rodar --dominio novo.elev.test
check "não troca no escuro: recusa" test "$RC" -ne 0
check "…explica a chave" tem "$OUT" "NEXT_PUBLIC_APP_URL"
check "…sem alterar nada" nada_mudou

echo "== REVERSÃO: o HTTPS novo não sobe"
novo_cenario
STUB_LOGIN_CODE=000 rodar --dominio novo.elev.test
check "falha" test "$RC" -ne 0
check "o .env volta BYTE A BYTE ao de antes" env_igual_ao_original
check "o cron NÃO foi tocado (não chama um endereço que não existe)" cron_igual_ao_original
check "os contêineres são recriados de novo (tentativa + reversão)" test "$(conta_up)" -eq 2
check "diz que o site segue no endereço antigo" tem "$OUT" "https://velho.hstgr.cloud"
check "…e que a troca NÃO ficou" tem "$OUT" "NÃO ficou"
check "não imprime nenhum segredo" nenhum_segredo_em "$OUT"
check "a conferência foi feita no endereço NOVO" grep -q 'https://novo.elev.test/login' "$CURL_LOG"

echo "== REVERSÃO: o docker não consegue recriar"
novo_cenario
STUB_UP_RC=1 rodar --dominio novo.elev.test
check "falha" test "$RC" -ne 0
check "o .env volta ao de antes" env_igual_ao_original
check "o cron NÃO foi tocado" cron_igual_ao_original

echo "== REVERSÃO: o app sobe mas não fica saudável"
novo_cenario
STUB_HEALTH=unhealthy rodar --dominio novo.elev.test
check "falha" test "$RC" -ne 0
check "o .env volta ao de antes" env_igual_ao_original
check "o cron NÃO foi tocado" cron_igual_ao_original
check "diz que o site segue no endereço antigo" tem "$OUT" "https://velho.hstgr.cloud"

echo "== servidor SEM crontab (estado de VPS recém-criada)"
novo_cenario
rm -f "$CRONTAB_FILE"
rodar --dominio novo.elev.test
check "não morre pelo crontab vazio" test "$RC" -eq 0
check "grava o cron do drain" grep -q 'https://novo.elev.test/api/v1/cron/event-log-drain' "$CRONTAB_FILE"

echo "== só INTERNAL_SECRET (instalação antiga, sem INTERNAL_CRON_SECRET)"
novo_cenario
sed -i '/^INTERNAL_CRON_SECRET=/d' "$PROJ/.env"
rodar --dominio novo.elev.test
check "termina bem" test "$RC" -eq 0
check "o cron usa o INTERNAL_SECRET (mesma regra do instalador)" grep -qF "Bearer $INT_SEG" "$CRONTAB_FILE"

echo
if [ "$FAILS" -eq 0 ]; then echo "trocar-dominio: tudo certo"; else echo "trocar-dominio: $FAILS falha(s)"; fi
exit "$FAILS"
