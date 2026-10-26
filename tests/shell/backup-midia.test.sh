#!/usr/bin/env bash
# Prova do backup dos arquivos do Storage (`hostgator-setup-kit/backup-midia.sh`).
#
#   bash tests/shell/backup-midia.test.sh
#
# ── O que ele guarda ────────────────────────────────────────────────────────
# Este backup guarda o que NÃO se refaz: a foto que o paciente mandou. Os defeitos que
# importam são os silenciosos:
#   - "ok" sem a cópia ter chegado (marcador carimbado cedo, origem que não se enxerga);
#   - `sync` no lugar de `copy`: o Storage do Supabase não tem versionamento, então apagar
#     um arquivo lá e deixar o backup acompanhar é apagar a única cópia;
#   - arquivo ou NOME de arquivo em claro no bucket de terceiros;
#   - senha curta, ou a senha na linha de comando.
#
# Nada aqui toca a máquina de quem roda: `docker` (inclusive o rclone) é um dublê que
# emula a origem (pasta) e o destino (pasta, com nomes e conteúdo "cifrados" de mentira de
# um jeito que o claro NÃO sobrevive — é assim que o teste enxerga um vazamento).
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

mkdir -p "$WORK/bin"

# docker: emula `rclone obscure -` e os subcomandos do rclone que o script usa.
#   origem  `supamidia:`   -> $FAKE_ORIGEM   (bucket/arquivo)
#   destino `midiacripto:` -> $FAKE_DESTINO  (nome = hash do caminho, conteúdo = base64)
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
[ "${1:-}" = "run" ] || exit 0
shift
mount_dados=""; achou=0; sub=""; resto=()
for a in "$@"; do
  case "$a" in *:/dados:ro) mount_dados="${a%%:/dados:ro}" ;; esac
  if [ "$achou" = 1 ] && [ -z "$sub" ]; then sub="$a"; continue; fi
  [ "$achou" = 1 ] && resto+=("$a")
  case "$a" in rclone/rclone:*) achou=1 ;; esac
done
[ "$achou" = 1 ] || exit 0

# O destino só é "cifrado" se o remoto foi montado como crypt COM nomes cifrados — é o que o
# script exporta. Se alguém montar de outro jeito (nome em claro), o dublê grava o nome em claro
# e o teste "os NOMES não aparecem no destino" pega.
nome_cifrado() {
  if [ "${RCLONE_CONFIG_MIDIACRIPTO_TYPE:-}" = crypt ] \
     && [ "${RCLONE_CONFIG_MIDIACRIPTO_FILENAME_ENCRYPTION:-}" = standard ] \
     && [ "${RCLONE_CONFIG_MIDIACRIPTO_DIRECTORY_NAME_ENCRYPTION:-}" = true ]; then
    printf '%s' "$1" | sha1sum | cut -c1-16
  else
    printf '%s' "$1" | tr '/' '_'
  fi
}
destino_de() { printf '%s/%s.enc' "$FAKE_DESTINO" "$(nome_cifrado "$1")"; }
# E o CONTEÚDO só vira ilegível se o remoto é um crypt; fora disso o dublê grava o arquivo como veio.
grava() { if [ "${RCLONE_CONFIG_MIDIACRIPTO_TYPE:-}" = crypt ]; then base64 < "$1" > "$2"; else cp "$1" "$2"; fi; }
le()    { if [ "${RCLONE_CONFIG_MIDIACRIPTO_TYPE:-}" = crypt ]; then base64 -d < "$1" 2>/dev/null; else cat "$1"; fi; }

case "$sub" in
  obscure)
    [ "${STUB_OBSCURE_RC:-0}" -eq 0 ] || exit "$STUB_OBSCURE_RC"
    senha="$(cat)"; printf 'OFUSCADA-%s\n' "$(printf '%s' "$senha" | base64 | tr -d '=\n' | cut -c1-12)" ;;
  lsf)
    case "${resto[0]}" in
      supamidia:*) [ "${STUB_LSF_ORIGEM_RC:-0}" -eq 0 ] || exit "$STUB_LSF_ORIGEM_RC"
                   [ "${STUB_ORIGEM_VAZIA:-0}" = 1 ] || ls -1 "$FAKE_ORIGEM" 2>/dev/null | sed 's|$|/|' ;;
      *)           exit "${STUB_LSF_DESTINO_RC:-0}" ;;
    esac ;;
  copy)
    [ "${STUB_COPY_RC:-0}" -eq 0 ] || { echo "ERROR : arquivo.jpg: boom na cópia" >&2; echo "NOTICE: Failed to copy" >&2; exit "$STUB_COPY_RC"; }
    mkdir -p "$FAKE_DESTINO"
    ( cd "$FAKE_ORIGEM" && find . -type f | sed 's|^\./||' ) | while IFS= read -r rel; do
      grava "$FAKE_ORIGEM/$rel" "$(destino_de "$rel")"
    done ;;
  check)
    [ "${STUB_CHECK_RC:-0}" -eq 0 ] || { echo "ERROR : arquivo.jpg: sizes differ" >&2; exit "$STUB_CHECK_RC"; }
    ( cd "$FAKE_ORIGEM" && find . -type f | sed 's|^\./||' ) | while IFS= read -r rel; do
      [ -f "$(destino_de "$rel")" ] || exit 1
    done ;;
  size)
    n="$(ls -1 "$FAKE_DESTINO" 2>/dev/null | wc -l | tr -d ' ')"
    printf 'Total objects: %s (%s)\nTotal size: 1 KiB (1024 Byte)\n' "$n" "$n" ;;
  copyto)   # /dados/<ts>.txt -> midiacripto:_teste/<ts>.txt
    [ "${STUB_COPY_RC:-0}" -eq 0 ] || exit "$STUB_COPY_RC"
    mkdir -p "$FAKE_DESTINO"
    alvo="${resto[1]#midiacripto:}"
    grava "$mount_dados/$(basename "${resto[0]}")" "$(destino_de "$alvo")" ;;
  cat)
    alvo="${resto[0]#midiacripto:}"
    [ "${STUB_CAT_ERRADO:-0}" = 1 ] && { echo "outra coisa"; exit 0; }
    le "$(destino_de "$alvo")" ;;
  deletefile)
    if [ "${STUB_DELETE_RC:-1}" -eq 0 ]; then rm -f "$(destino_de "${resto[0]#midiacripto:}")"; exit 0; fi
    exit 1 ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

SENHA="uma-senha-bem-longa-para-o-teste-0123456789"
SENTINELA="CONTEUDO-DA-FOTO-DO-PACIENTE-NAO-PODE-VAZAR"

novo_projeto() {  # novo_projeto <nome> [linhas extras do .env...]
  P="$WORK/$1"; shift
  LOG="$P/stub.log"; export FAKE_ORIGEM="$P/origem" FAKE_DESTINO="$P/destino"
  mkdir -p "$P" "$FAKE_ORIGEM/whatsapp-media/2029" "$FAKE_DESTINO"
  : > "$P/docker-compose.prod.yml"; : > "$LOG"
  printf '%s\n' "$SENTINELA foto 1" > "$FAKE_ORIGEM/whatsapp-media/2029/foto-paciente-fulano.jpg"
  printf '%s\n' "$SENTINELA audio" > "$FAKE_ORIGEM/whatsapp-media/2029/audio.ogg"
  {
    echo "BACKUP_MIDIA_ORIGEM=supamidia:"
    echo "BACKUP_MIDIA_DESTINO=fora:bucket/elevcrm-midia"
    echo "BACKUP_MIDIA_SENHA=$SENHA"
    echo "RCLONE_CONFIG_SUPAMIDIA_TYPE=s3"
    echo "RCLONE_CONFIG_SUPAMIDIA_SECRET_ACCESS_KEY=SEGREDO-S3-DO-SUPABASE"
    for linha in "$@"; do echo "$linha"; done
  } > "$P/.env"
}

midia() {  # midia [args...] → OUT e RC
  RC=0
  OUT="$(cd "$P" && STUB_LOG="$LOG" BACKUP_MIDIA_TS=20290101-034700 bash "$KIT_DIR/backup-midia.sh" "$@" 2>&1)" || RC=$?
}
ARQ_DESTINO() { ls "$FAKE_DESTINO" 2>/dev/null | wc -l | tr -d ' '; }

# ══ Caminho feliz ════════════════════════════════════════════════════════════
echo "o caminho feliz"
novo_projeto feliz
midia
check "sai 0" test "$RC" -eq 0
check "copiou os 2 arquivos para o destino" test "$(ARQ_DESTINO)" -eq 2
check "o marcador de sucesso nasceu" test -s "$P/.backup-midia.ok"
check "  e é um epoch numérico (o monitor.sh lê assim)" grep -Eq '^[0-9]+$' "$P/.backup-midia.ok"
check "mostra o resumo do que está no destino" tem "$OUT" "Total objects: 2"
check "sem rastro de falha" test ! -e "$P/.backup-midia.fail"

echo "nada em claro"
check "o CONTEÚDO não aparece em claro no destino" test -z "$(grep -rl "$SENTINELA" "$FAKE_DESTINO" 2>/dev/null)"
check "os NOMES dos arquivos não aparecem no destino" test -z "$(ls "$FAKE_DESTINO" | grep -E 'foto|paciente|fulano|audio')"

echo "a senha e as chaves ficam fora da linha de comando"
check "a SENHA da cifra não aparece em nenhuma linha do docker" naotem "$(cat "$LOG")" "$SENHA"
check "a chave S3 do Supabase também não" naotem "$(cat "$LOG")" "SEGREDO-S3-DO-SUPABASE"
check "a cifra é entregue por NOME (-e RCLONE_CONFIG_MIDIACRIPTO_PASSWORD)" tem "$(cat "$LOG")" "-e RCLONE_CONFIG_MIDIACRIPTO_PASSWORD"
check "a senha vai ao rclone pelo stdin ('obscure -')" tem "$(cat "$LOG")" "obscure -"

echo "copy, nunca sync"
check "usa 'copy'" tem "$(cat "$LOG")" " copy supamidia: midiacripto:"
check "NÃO usa 'sync' (apagaria do backup o que sumiu da origem)" naotem "$(cat "$LOG")" " sync "

echo "incremental, e o backup guarda o que já existiu"
printf 'foto nova\n' > "$FAKE_ORIGEM/whatsapp-media/2029/foto-nova.jpg"
rm "$FAKE_ORIGEM/whatsapp-media/2029/audio.ogg"       # sumiu da ORIGEM (o paciente/atendente apagou)
midia
check "o arquivo novo entra no backup" test "$(ARQ_DESTINO)" -eq 3
check "o arquivo que SUMIU da origem continua no backup (é para isso que ele serve)" test "$(ARQ_DESTINO)" -ge 3

# ══ Configuração errada: recusa antes de tocar em qualquer coisa ═════════════
echo "configuração"
novo_projeto semsenha "BACKUP_MIDIA_SENHA="
midia
check "sem senha: recusa" test "$RC" -ne 0
check "  e diz o que falta" tem "$OUT" "Falta BACKUP_MIDIA_ORIGEM"
check "  deixa rastro em .backup-midia.fail" test -s "$P/.backup-midia.fail"
check "  sem falar com o armazenamento" naotem "$(cat "$LOG")" "rclone"

novo_projeto senhacurta "BACKUP_MIDIA_SENHA=curta123"
midia
check "senha curta (< 24 caracteres): recusa" test "$RC" -ne 0
check "  e ensina a gerar uma" tem "$OUT" "openssl rand"
check "  nada foi copiado" test "$(ARQ_DESTINO)" -eq 0

novo_projeto mesmoremoto "BACKUP_MIDIA_DESTINO=supamidia:bucket/x"
midia
check "destino no MESMO remoto da origem: recusa (copiaria o Storage para dentro dele mesmo)" test "$RC" -ne 0
check "  e explica que o backup tem de ir para fora do Supabase" tem "$OUT" "FORA do Supabase"

novo_projeto semdoispontos "BACKUP_MIDIA_ORIGEM=supamidia"
midia
check "origem sem 'remoto:': recusa" test "$RC" -ne 0
novo_projeto destsemdoispontos "BACKUP_MIDIA_DESTINO=bucket/pasta"
midia
check "destino sem 'remoto:': recusa" test "$RC" -ne 0

novo_projeto obscurefalha
STUB_OBSCURE_RC=1 midia
check "o rclone não prepara a cifra: recusa" test "$RC" -ne 0
check "  e diz que o Docker/rclone não respondeu" tem "$OUT" "preparar a cifra"

# ══ Origem e destino que não se enxergam ═════════════════════════════════════
echo "acesso"
novo_projeto origemfora
STUB_LSF_ORIGEM_RC=1 midia
check "origem inacessível: recusa" test "$RC" -ne 0
check "  e aponta o endereço/as chaves do Storage" tem "$OUT" "Não consegui acessar a origem"

novo_projeto origemvazia
STUB_ORIGEM_VAZIA=1 midia
check "origem que não lista NENHUM bucket: recusa (a chave não enxerga nada)" test "$RC" -ne 0
check "  e diz isso" tem "$OUT" "não lista nenhum bucket"
check "  sem carimbar sucesso" test ! -e "$P/.backup-midia.ok"

novo_projeto destinofora
STUB_LSF_DESTINO_RC=1 midia
check "destino inacessível: recusa" test "$RC" -ne 0
check "  e aponta credenciais/bucket" tem "$OUT" "Não consegui acessar o destino"

# ══ As falhas que NÃO podem carimbar "ok" ════════════════════════════════════
echo "falhas não carimbam sucesso"
ANTIGO=1700000000
novo_projeto copiafalha; echo "$ANTIGO" > "$P/.backup-midia.ok"
STUB_COPY_RC=1 midia
check "cópia que falha: recusa" test "$RC" -ne 0
check "  marcador intacto (o monitor vai envelhecer e acusar)" test "$(cat "$P/.backup-midia.ok")" = "$ANTIGO"
check "  o rastro leva a CAUSA do rclone, não só 'falhou'" grep -q "boom na cópia" "$P/.backup-midia.fail"

novo_projeto conferefalha; echo "$ANTIGO" > "$P/.backup-midia.ok"
STUB_CHECK_RC=1 midia
check "arquivo que não chegou inteiro: recusa" test "$RC" -ne 0
check "  diz que NÃO chegou" tem "$OUT" "NÃO chegou inteiro"
check "  marcador intacto (copiar sem conferir não é backup)" test "$(cat "$P/.backup-midia.ok")" = "$ANTIGO"
check "  o rastro leva a causa da conferência" grep -q "sizes differ" "$P/.backup-midia.fail"

novo_projeto recupera; echo "x" > "$P/.backup-midia.fail"
midia
check "um sucesso apaga o rastro da falha anterior" test ! -e "$P/.backup-midia.fail"

# ══ Um por vez ═══════════════════════════════════════════════════════════════
echo "concorrência"
novo_projeto lock
( exec 8>"$P/.backup-midia.lock"; flock 8; sleep 6 ) &
TRAVA=$!
sleep 1
midia
check "com outra cópia em curso: sai 0 sem atropelar" test "$RC" -eq 0
check "  diz que já há uma em andamento" tem "$OUT" "em andamento"
check "  e não copiou nada" test "$(ARQ_DESTINO)" -eq 0
kill "$TRAVA" 2>/dev/null; wait "$TRAVA" 2>/dev/null

# ══ --teste ══════════════════════════════════════════════════════════════════
echo "--teste"
novo_projeto teste
STUB_DELETE_RC=1 midia --teste
check "chave que NÃO consegue apagar: sai 0 e elogia" tem "$OUT" "NÃO consegue apagar"
check "  confere a ida e volta pela cifra" tem "$OUT" "volta igual pela cifra"
check "  não copia a mídia (só o arquivo de teste)" test "$(ARQ_DESTINO)" -le 1
check "  nem carimba sucesso" test ! -e "$P/.backup-midia.ok"

novo_projeto teste2
STUB_DELETE_RC=0 midia --teste
check "chave que CONSEGUE apagar: AVISA com todas as letras" tem "$OUT" "consegue APAGAR"
check "  mas não é erro (o backup funciona)" test "$RC" -eq 0

novo_projeto teste3
STUB_COPY_RC=1 midia --teste
check "sem poder escrever: falha" test "$RC" -ne 0
check "  e diz que falta permissão de escrita" tem "$OUT" "ESCREVER"

novo_projeto teste4
STUB_CAT_ERRADO=1 midia --teste
check "o arquivo NÃO volta igual pela cifra (senha/cifra erradas): falha" test "$RC" -ne 0
check "  e diz que a senha ou a cifra estão erradas" tem "$OUT" "senha ou a cifra"

novo_projeto opcao
midia --nao-existe
check "opção desconhecida é recusada" test "$RC" -ne 0

echo
if [ "$FAILS" -eq 0 ]; then echo "backup-midia: tudo verde"; exit 0; fi
echo "backup-midia: $FAILS falha(s)"; exit 1
