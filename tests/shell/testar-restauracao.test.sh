#!/usr/bin/env bash
# Prova da prova de restauração (`hostgator-setup-kit/testar-restauracao.sh`).
#
#   bash tests/shell/testar-restauracao.test.sh
#
# ── O que ele guarda ────────────────────────────────────────────────────────
# O testar-restauracao.sh existe para NÃO deixar passar um backup ruim. Então o
# defeito que importa aqui é o falso positivo: dizer "BACKUP PROVADO" sobre um backup
# corrompido, sem manifesto, cifrado para outra chave, ou que não carrega. Cada um
# desses tem um caso — e cada um precisa terminar com "NÃO foi provado" e exit != 0.
#
# Nada aqui toca a máquina de quem roda: `docker` (inclusive o rclone e o Postgres
# descartável) e `age` são dublês; o "bucket" é uma pasta temporária.
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

# age -d -i <chave> <arquivo>: só abre se a chave for a "certa"; devolve o conteúdo.
cat > "$WORK/bin/age" <<'STUB'
#!/usr/bin/env bash
chave=""; arq=""
while [ $# -gt 0 ]; do
  case "$1" in -d) ;; -i) chave="$2"; shift ;; *) arq="$1" ;; esac
  shift
done
[ "$(cat "$chave" 2>/dev/null)" = "CHAVE-CERTA" ] || { echo "age: no identity matched any of the file's recipients" >&2; exit 1; }
[ "$(head -1 "$arq")" = "AGE-STUB v1" ] || exit 1
tail -n +2 "$arq" | base64 -d
STUB

# docker: emula o rclone (contra uma pasta), o Postgres descartável e a consulta ao vivo.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
remoto() { printf '%s/%s' "$FAKE_REMOTE" "${1#*:}"; }
case "${1:-}" in
  rm) exit 0 ;;
  exec)
    shift
    if [[ " $* " == *" pg_isready "* ]]; then exit 0; fi
    sql=""; achou_c=0
    for a in "$@"; do
      if [ "$achou_c" = 1 ]; then sql="$a"; achou_c=0; fi
      [ "$a" = "-c" ] && achou_c=1
    done
    case "$sql" in
      "select count(*) from information_schema"*) printf '%s\n' "${STUB_TABELAS:-12}"; exit 0 ;;
      "select count(*) from public."*)            printf '%s\n' "${STUB_LINHAS:-5}"; exit 0 ;;
      "create extension"*)                        exit 0 ;;
    esac
    # sem -c: ou é o prelúdio (papéis/extensões) ou é o dump chegando pelo stdin
    entrada="$(cat)"
    case "$entrada" in "-- elevcrm: prel"*) echo "prelúdio" >> "$STUB_LOG"; exit 0 ;; esac
    # o prelúdio já tinha rodado quando o dump chegou? (a ordem é o ponto)
    grep -q 'prelúdio' "$STUB_LOG" && : > "$STUB_SQL_RESTAURADO.com-preludio"
    printf '%s' "$entrada" > "$STUB_SQL_RESTAURADO"
    printf '%s' "${STUB_ERROS:-}" >&2
    exit 0 ;;
  run) ;;
  *) exit 0 ;;
esac
shift
# ── consulta ao banco VIVO (a imagem do postgres, sem rclone)
case " $* " in
  *" postgres:17-alpine "*) printf '%s\n' "${STUB_TABELAS_VIVO-12}"; exit 0 ;;
  *" -d "*|*pgvector*) exit 0 ;;   # sobe o descartável
esac
# ── rclone
mount=""; achou=0; sub=""; resto=()
for a in "$@"; do
  case "$a" in *:/saida) mount="${a%%:/saida}" ;; esac
  if [ "$achou" = 1 ] && [ -z "$sub" ]; then sub="$a"; continue; fi
  [ "$achou" = 1 ] && resto+=("$a")
  case "$a" in rclone/rclone:*) achou=1 ;; esac
done
# A mídia: o remoto `midiacripto:` enxerga a mesma pasta que o destino bruto, MAS só se a senha
# for a certa — com a senha errada o rclone de verdade não dá erro, mostra o backup vazio.
midia_dir="$FAKE_REMOTE/bucket/elevcrm-midia"
senha_abre() { [ "${RCLONE_CONFIG_MIDIACRIPTO_PASSWORD:-}" = "OFUSCADA-OK" ]; }
case "$sub" in
  obscure) senha="$(cat)"; if [ "$senha" = "${STUB_SENHA_CERTA:-senha-certa-da-midia-0123456789}" ]; then echo OFUSCADA-OK; else echo OFUSCADA-ERRADA; fi ;;
  size)
    # as duas leituras falham SEPARADAS: com uma só chave, o segundo guarda do script reprovava
    # sempre e escondia que o primeiro tinha sido removido
    case "${resto[0]}" in
      midiacripto:*) [ "${STUB_SIZE_CRIPTO_RC:-0}" -eq 0 ] || exit "$STUB_SIZE_CRIPTO_RC"
                     if senha_abre; then n="$(ls -1 "$midia_dir" 2>/dev/null | wc -l | tr -d ' ')"; else n=0; fi ;;
      *)             [ "${STUB_SIZE_BRUTO_RC:-0}" -eq 0 ] || exit "$STUB_SIZE_BRUTO_RC"
                     n="$(ls -1 "$(remoto "${resto[0]}")" 2>/dev/null | wc -l | tr -d ' ')" ;;
    esac
    printf 'Total objects: %s (%s)\nTotal size: 1 KiB (1024 Byte)\n' "$n" "$n" ;;
  lsf)  case "${resto[0]}" in
          midiacripto:*) if senha_abre && [ "${STUB_SEM_AMOSTRA:-0}" != 1 ]; then ls -1 "$midia_dir" 2>/dev/null; fi ;;
          *) ls -1 "$(remoto "${resto[0]}")" 2>/dev/null | sed 's|$|/|' ;;
        esac ;;
  copy) case "${resto[0]}" in
          midiacripto:*) senha_abre || exit 0
                         mkdir -p "$mount/midia"; cp -r "$midia_dir"/. "$mount/midia"/
                         exit "${STUB_AMOSTRA_RC:-0}" ;;
          *) origem="$(remoto "${resto[0]}")"; destino="$mount${resto[1]#/saida}"
             [ -d "$origem" ] || exit 1
             mkdir -p "$destino"; cp -r "$origem"/. "$destino"/ ;;
        esac ;;
esac
exit 0
STUB
chmod +x "$WORK"/bin/*
PATH="$WORK/bin:$PATH"

# ── Fixture: um backup "de verdade" no bucket de mentira ─────────────────────
SQL_BOM="create table public.contacts (id int); insert into public.contacts values (1);"
cria_backup() {  # cria_backup <timestamp> — deixa tudo consistente com o manifesto
  local ts="$1" d="$FAKE_REMOTE/bucket/elevcrm/$1"
  mkdir -p "$d"
  { echo "AGE-STUB v1"; printf '%s' "$SQL_BOM" | gzip | base64; } > "$d/db-$ts.sql.gz.age"
  { echo "AGE-STUB v1"; printf 'AI_CRED_AES_KEY=abc\n' | base64; } > "$d/env-$ts.age"
  {
    echo "elevcrm-backup $ts"
    ( cd "$d" && for f in *.age; do printf '%s  %s bytes  sha256:%s\n' "$f" "$(wc -c < "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"; done )
  } > "$d/MANIFEST-$ts.txt"
}

novo_cenario() {  # novo_cenario <nome> [linhas extras do env]
  C="$WORK/$1"; shift
  export FAKE_REMOTE="$C/remoto" STUB_LOG="$C/stub.log" STUB_SQL_RESTAURADO="$C/restaurado.sql"
  mkdir -p "$FAKE_REMOTE/bucket/elevcrm"; : > "$STUB_LOG"
  echo "CHAVE-CERTA" > "$C/age.key"; chmod 600 "$C/age.key"
  {
    echo "BACKUP_FORA_DESTINO=fora:bucket/elevcrm"
    echo "RCLONE_CONFIG_FORA_TYPE=b2"
    for l in "$@"; do echo "$l"; done
  } > "$C/cliente.env"
}

restaura() {  # restaura [args...] → OUT e RC
  RC=0
  OUT="$(bash "$KIT_DIR/testar-restauracao.sh" --chave-privada "$C/age.key" --env "$C/cliente.env" "$@" 2>&1)" || RC=$?
}

# ══ O backup bom ═════════════════════════════════════════════════════════════
echo "o backup bom"
novo_cenario bom
cria_backup 20290101-031700
cria_backup 20290102-031700
restaura
check "sai 0" test "$RC" -eq 0
check "diz BACKUP PROVADO" tem "$OUT" "BACKUP PROVADO"
check "sem --em, usa o MAIS RECENTE" tem "$OUT" "usando o backup 20290102-031700"
check "carregou o dump no Postgres descartável (o SQL chegou por stdin, decifrado)" grep -q 'create table public.contacts' "$C/restaurado.sql"
check "prepara os papéis e o schema extensions do Supabase ANTES de carregar o dump" test -e "$C/restaurado.sql.com-preludio"
check "confere os hashes do manifesto" tem "$OUT" "todos os arquivos conferem com o manifesto"
check "diz que a chave abre o backup" tem "$OUT" "a chave privada abre o backup"
check "mostra o número de tabelas restauradas" tem "$OUT" "12 tabelas"
check "NÃO imprime o conteúdo do .env decifrado" naotem "$OUT" "AI_CRED_AES_KEY"
check "o Postgres descartável é removido no fim" tem "$(cat "$STUB_LOG")" "docker rm -f elevcrm-restauracao-"
check "lembra que isto não substitui o ensaio num Supabase" tem "$OUT" "ensaio trimestral"

restaura --em 20290101-031700
check "--em escolhe um backup específico" tem "$OUT" "usando o backup 20290101-031700"

# ══ Os falsos positivos que a prova existe para impedir ══════════════════════
echo "o que NÃO pode ser provado"
novo_cenario corrompido
cria_backup 20290101-031700
echo "lixo" >> "$FAKE_REMOTE/bucket/elevcrm/20290101-031700/db-20290101-031700.sql.gz.age"
restaura
check "arquivo corrompido: reprova" test "$RC" -ne 0
check "  diz que o hash não confere" tem "$OUT" "corrompido"
check "  e diz que o backup NÃO foi provado" tem "$OUT" "NÃO foi provado"
check "  sem chegar a restaurar nada" test ! -e "$C/restaurado.sql"

novo_cenario semmanifesto
cria_backup 20290101-031700
rm "$FAKE_REMOTE/bucket/elevcrm/20290101-031700/MANIFEST-20290101-031700.txt"
restaura
check "sem manifesto (backup interrompido): reprova" test "$RC" -ne 0
check "  e explica" tem "$OUT" "não tem manifesto"

novo_cenario faltaarquivo
cria_backup 20290101-031700
rm "$FAKE_REMOTE/bucket/elevcrm/20290101-031700/db-20290101-031700.sql.gz.age"
restaura
check "o manifesto lista um arquivo que não chegou: reprova" test "$RC" -ne 0
check "  com a mensagem certa (e não por um acidente do shell)" tem "$OUT" "que não chegou"

# Um "backup" que tem o .env mas NÃO tem o dump do banco não prova nada sobre o banco.
novo_cenario semdump
cria_backup 20290101-031700
d="$FAKE_REMOTE/bucket/elevcrm/20290101-031700"
rm "$d/db-20290101-031700.sql.gz.age"
grep -v '^db-' "$d/MANIFEST-20290101-031700.txt" > "$d/m.tmp" && mv "$d/m.tmp" "$d/MANIFEST-20290101-031700.txt"
restaura
check "manifesto sem o dump do banco: reprova" test "$RC" -ne 0
check "  e diz que o dump não está listado" tem "$OUT" "não lista o dump do banco"

novo_cenario chaveerrada
cria_backup 20290101-031700
echo "OUTRA-CHAVE" > "$C/age.key"
restaura
check "chave privada errada: reprova" test "$RC" -ne 0
check "  diz que a chave NÃO abre" tem "$OUT" "NÃO abre o .env"
check "  e não afirma que o backup foi provado" naotem "$OUT" "BACKUP PROVADO"

novo_cenario vazio
cria_backup 20290101-031700
STUB_TABELAS=0 restaura
check "o dump não carrega (public vazio): reprova" test "$RC" -ne 0
check "  diz que nada foi restaurado" tem "$OUT" "Nada foi restaurado"

novo_cenario nenhum
restaura
check "bucket sem nenhum backup: reprova" test "$RC" -ne 0
check "  e diz que não há nenhum" tem "$OUT" "NENHUM backup"

# ══ Comparação com o banco vivo ══════════════════════════════════════════════
echo "comparação com o banco vivo"
novo_cenario vivoigual "SUPABASE_DB_URL=postgresql://u:p@h:5432/db"
cria_backup 20290101-031700
STUB_TABELAS=12 STUB_TABELAS_VIVO=12 restaura
check "mesmo número de tabelas: confirma" tem "$OUT" "mesmo número de tabelas que o banco vivo"
check "  e prova" test "$RC" -eq 0

novo_cenario vivodiferente "SUPABASE_DB_URL=postgresql://u:p@h:5432/db"
cria_backup 20290101-031700
STUB_TABELAS=10 STUB_TABELAS_VIVO=12 restaura
check "o backup tem MENOS tabelas que o banco vivo: reprova" test "$RC" -ne 0
check "  e mostra os dois números" tem "$OUT" "10 tabelas"

novo_cenario vivofora "SUPABASE_DB_URL=postgresql://u:p@h:5432/db"
cria_backup 20290101-031700
STUB_TABELAS_VIVO= restaura
check "banco vivo inalcançável: avisa que pulou, e não reprova" tem "$OUT" "comparação pulada"

novo_cenario semvivo
cria_backup 20290101-031700
restaura
check "sem SUPABASE_DB_URL: diz que não comparou" tem "$OUT" "não comparei com o banco vivo"

novo_cenario senhasegura "SUPABASE_DB_URL=postgresql://postgres:SENHA-DO-BANCO-9z@h:5432/db"
cria_backup 20290101-031700
restaura
check "a senha do banco vivo NÃO vai na linha de comando do docker" naotem "$(cat "$STUB_LOG")" "SENHA-DO-BANCO-9z"

# ══ Erros esperados do Supabase ═══════════════════════════════════════════════
echo "erros da carga"
novo_cenario erros
cria_backup 20290101-031700
STUB_ERROS=$'ERROR:  extension "pg_graphql" is not available\nERROR:  extension "pg_graphql" is not available\nERROR:  role "supabase_admin" does not exist\n' restaura
check "lista os erros da carga, agrupados" tem "$OUT" 'extension "pg_graphql" is not available'
check "  com a contagem" tem "$OUT" "3 erro(s) durante a carga"
check "  e erros esperados NÃO reprovam (é Postgres comum, não Supabase)" test "$RC" -eq 0

# ══ A mídia (fotos e áudios dos pacientes) ═══════════════════════════════════
echo "a mídia"
MIDIA_ENV=("BACKUP_MIDIA_ORIGEM=supamidia:" "BACKUP_MIDIA_DESTINO=fora:bucket/elevcrm-midia" "BACKUP_MIDIA_SENHA=senha-certa-da-midia-0123456789")
cria_midia() {  # cria_midia <n> — n arquivos no destino bruto da mídia
  local d="$FAKE_REMOTE/bucket/elevcrm-midia" i
  mkdir -p "$d"
  for i in $(seq 1 "$1"); do printf 'conteudo %s\n' "$i" > "$d/$i.enc"; done
}

novo_cenario midiaok "${MIDIA_ENV[@]}"
cria_backup 20290101-031700; cria_midia 3
restaura
check "com mídia configurada e a senha certa: prova" test "$RC" -eq 0
check "  diz quantos arquivos abrem com a senha" tem "$OUT" "3 arquivo(s) de mídia abrem com a senha"
check "  baixa e decifra uma amostra de verdade" tem "$OUT" "baixei e decifrei 3 arquivo(s) de amostra"
check "  e ainda diz BACKUP PROVADO" tem "$OUT" "BACKUP PROVADO"

# O caso traiçoeiro: senha ERRADA não dá erro no rclone — ele mostra o backup VAZIO.
novo_cenario midiasenhaerrada "BACKUP_MIDIA_ORIGEM=supamidia:" "BACKUP_MIDIA_DESTINO=fora:bucket/elevcrm-midia" "BACKUP_MIDIA_SENHA=outra-senha-que-nao-abre-0123456789"
cria_backup 20290101-031700; cria_midia 3
restaura
check "senha ERRADA da mídia: REPROVA (o destino tem arquivos, mas nenhum abre)" test "$RC" -ne 0
check "  e diz que a senha não abre" tem "$OUT" "a senha está errada"
check "  sem afirmar BACKUP PROVADO" naotem "$OUT" "BACKUP PROVADO"

novo_cenario midiavazia "${MIDIA_ENV[@]}"
cria_backup 20290101-031700
restaura
check "mídia ainda vazia (nada enviado): não reprova, mas diz" tem "$OUT" "ainda está vazio"
check "  e prova o banco normalmente" test "$RC" -eq 0

novo_cenario midiasemamostra "${MIDIA_ENV[@]}"
cria_backup 20290101-031700; cria_midia 2
STUB_SEM_AMOSTRA=1 restaura
check "nenhum arquivo pequeno para amostrar: avisa que não conferiu o conteúdo" tem "$OUT" "não conferi o conteúdo"

novo_cenario midialeituraquebra "${MIDIA_ENV[@]}"
cria_backup 20290101-031700; cria_midia 2
STUB_SIZE_BRUTO_RC=1 restaura
check "não consegue ler o destino BRUTO da mídia: REPROVA" test "$RC" -ne 0
check "  e diz que foi o destino" tem "$OUT" "ler o destino da mídia"

novo_cenario midiacriptoquebra "${MIDIA_ENV[@]}"
cria_backup 20290101-031700; cria_midia 2
STUB_SIZE_CRIPTO_RC=1 restaura
check "não consegue ler a mídia PELA CIFRA: REPROVA" test "$RC" -ne 0
check "  e diz que foi pela cifra" tem "$OUT" "pela cifra"

novo_cenario midiaamostrafalha "${MIDIA_ENV[@]}"
cria_backup 20290101-031700; cria_midia 2
STUB_AMOSTRA_RC=1 restaura
check "a amostra não baixa: REPROVA" test "$RC" -ne 0
check "  e diz isso" tem "$OUT" "baixar uma amostra"

# A amostra é uma LISTA explícita (--files-from), nunca um teto de bytes: com --max-transfer o
# rclone abandona a cópia no meio e falha ao ajustar a data das pastas ("chtimes … no such file"),
# e um backup BOM reprovava assim que a mídia passava do teto — achado pela prova real contra o
# Storage, que o dublê não reproduz. Este caso trava a ESCOLHA, já que o dublê não tem como errar.
novo_cenario midialista "${MIDIA_ENV[@]}"
cria_backup 20290101-031700; cria_midia 3
restaura
check "a amostra é baixada por lista explícita (--files-from)" tem "$(cat "$STUB_LOG")" "--files-from"
check "  e NÃO por teto de bytes (--max-transfer)" naotem "$(cat "$STUB_LOG")" "--max-transfer"

novo_cenario semmidia
cria_backup 20290101-031700
restaura
check "sem mídia no .env: avisa que não provou os arquivos dos pacientes" tem "$OUT" "não provei os arquivos dos pacientes"
check "  e a prova do banco segue verde" test "$RC" -eq 0

novo_cenario midiasenhanalinha "${MIDIA_ENV[@]}"
cria_backup 20290101-031700; cria_midia 1
restaura
check "a SENHA da mídia não aparece na linha de comando do docker" naotem "$(cat "$STUB_LOG")" "senha-certa-da-midia-0123456789"

# ══ Argumentos ═══════════════════════════════════════════════════════════════
echo "argumentos"
novo_cenario args
RC=0; OUT="$(bash "$KIT_DIR/testar-restauracao.sh" --env "$C/cliente.env" 2>&1)" || RC=$?
check "sem --chave-privada: recusa" test "$RC" -ne 0
RC=0; OUT="$(bash "$KIT_DIR/testar-restauracao.sh" --chave-privada "$C/nao-existe" --env "$C/cliente.env" 2>&1)" || RC=$?
check "chave inexistente: recusa" test "$RC" -ne 0
RC=0; OUT="$(bash "$KIT_DIR/testar-restauracao.sh" --chave-privada "$C/age.key" --env "$C/nao-existe.env" 2>&1)" || RC=$?
check ".env inexistente: recusa" test "$RC" -ne 0
chmod 644 "$C/age.key"
cria_backup 20290101-031700
restaura
check "chave privada legível por todos: avisa" tem "$OUT" "chmod 600"

echo
if [ "$FAILS" -eq 0 ]; then echo "testar-restauracao: tudo verde"; exit 0; fi
echo "testar-restauracao: $FAILS falha(s)"; exit 1
