#!/usr/bin/env bash
# Prova que o backup fora da VPS RESTAURA — num Postgres descartável, sem tocar no banco vivo.
#
#   bash hostgator-setup-kit/testar-restauracao.sh --chave-privada ~/age.key
#   bash hostgator-setup-kit/testar-restauracao.sh --chave-privada ~/age.key --em 20291001-031700
#   bash hostgator-setup-kit/testar-restauracao.sh --chave-privada ~/age.key --env ~/cliente.env
#
# Rode todo mês (e depois de qualquer mudança no backup). Backup que nunca foi restaurado
# é uma hipótese, não um backup: dump vazio, chave errada, arquivo truncado e senha
# esquecida só aparecem na hora do desastre — que é a pior hora de descobrir.
#
# ── Onde rodar ──────────────────────────────────────────────────────────────
# De preferência no computador de quem guarda a chave PRIVADA, e não na VPS: a privada
# nunca deve ficar no servidor. Basta um arquivo .env pequeno com BACKUP_FORA_DESTINO e as
# RCLONE_CONFIG_* (e SUPABASE_DB_URL, se quiser comparar com o banco vivo). Precisa de
# Docker e do `age`.
#
# ── O que ele prova, e o que NÃO prova ──────────────────────────────────────
# PROVA: o backup mais recente existe, chegou inteiro (hash do manifesto), decifra com a
#        chave privada, descomprime e CARREGA — e, com SUPABASE_DB_URL no .env, tem o
#        mesmo número de tabelas do banco vivo e linhas nas tabelas que importam.
# NÃO PROVA: a restauração de volta num Supabase (autenticação, storage, extensões do
#        Supabase). O Postgres descartável não é um Supabase: erros de extensão/role do
#        Supabase são esperados e listados, não escondidos. Uma vez por trimestre, faça
#        o ensaio completo num projeto Supabase descartável (docs/runbooks/operacao-24h.md).
#        Também NÃO cobre os arquivos de mídia do Storage — o dump é só do banco.
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=_common.sh
source "$KIT_DIR/_common.sh"

RCLONE_IMAGE="${BACKUP_RCLONE_IMAGE:-rclone/rclone:1.68.2}"
PG_IMAGE="${RESTAURACAO_PG_IMAGE:-pgvector/pgvector:pg17}"
TABELAS_QUE_IMPORTAM="organizations contacts conversations messages channel_sessions"
PG_ALPINE="${BACKUP_PG_IMAGE:-postgres:17-alpine}"
# Dollar-quoting ($$…$$): o mesmo texto serve ao banco descartável e ao vivo, sem
# aspas simples aninhadas em aspas de shell.
SQL_TABELAS='select count(*) from information_schema.tables where table_schema = $$public$$ and table_type = $$BASE TABLE$$'
CONTAINER=""; TMP=""

limpar() {
  [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1
  [ -n "$TMP" ] && rm -rf "$TMP"
  return 0
}

reprovar() { c_red "✖ $*"; c_red "  O backup NÃO foi provado. Trate-o como inexistente até corrigir."; exit 1; }

rclone_run() {  # rclone_run <args...> — a pasta de saída é $TMP montado em /saida
  local env_args=() nome
  while IFS= read -r nome; do [ -n "$nome" ] && env_args+=(-e "$nome"); done < <(compgen -e | grep '^RCLONE_CONFIG_' || true)
  # `--user`: sem ele o rclone roda como root DENTRO do contêiner e grava em $TMP arquivos
  # de root, que este script (rodando como o usuário) não consegue apagar no fim — a
  # pasta temporária ficaria para trás a cada execução. `HOME=/tmp` porque esse usuário
  # não existe na imagem e o rclone quer um lugar para o cache.
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp "${env_args[@]+"${env_args[@]}"}" \
    -v "$TMP:/saida" "$RCLONE_IMAGE" "$@"
}

psql_descartavel() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -q -X "$@"; }

# Número de objetos de um `rclone size` ("Total objects: 531 (531)"). Vazio se não leu.
objetos_de() { sed -n 's/^Total objects: *\([0-9][0-9]*\).*/\1/p' | head -1; }

# Os arquivos de mídia (fotos e áudios dos pacientes) vivem em outro backup, cifrado com uma
# SENHA (rclone crypt), e a prova precisa abrir esse também — senão "BACKUP PROVADO" cobriria só o
# banco e daria confiança sobre o que ela não olhou.
#
# O caso traiçoeiro: com a senha ERRADA o rclone não dá erro — ele "não consegue decifrar os
# nomes" e mostra o backup VAZIO. Por isso a contagem de dentro da cifra é confrontada com a
# contagem bruta do destino: bruto cheio e decifrado vazio = a senha não abre.
provar_a_midia() {
  backup_midia_configurado || { c_dim "  (sem backup de mídia no .env: não provei os arquivos dos pacientes)"; return 0; }
  step "Arquivos de mídia (fotos, áudios, documentos)"
  exportar_cripto_da_midia || reprovar "Não consegui montar a cifra da mídia (BACKUP_MIDIA_SENHA / Docker)."

  local bruto decifrado n_bruto n_dec
  bruto="$(rclone_run size "${BACKUP_MIDIA_DESTINO%/}" 2>&1)" || reprovar "Não consegui ler o destino da mídia '${BACKUP_MIDIA_DESTINO%/}'."
  n_bruto="$(printf '%s\n' "$bruto" | objetos_de)"
  decifrado="$(rclone_run size midiacripto: 2>&1)" || reprovar "Não consegui ler o backup da mídia pela cifra."
  n_dec="$(printf '%s\n' "$decifrado" | objetos_de)"
  n_bruto="${n_bruto:-0}"; n_dec="${n_dec:-0}"

  if [ "$n_bruto" -gt 0 ] && [ "$n_dec" -eq 0 ]; then
    reprovar "O destino da mídia tem $n_bruto objeto(s), mas NENHUM abre com a BACKUP_MIDIA_SENHA — a senha está errada."
  fi
  if [ "$n_dec" -eq 0 ]; then
    c_dim "  o backup da mídia ainda está vazio (nenhum arquivo foi enviado até agora)"
    return 0
  fi
  c_grn "✓ $n_dec arquivo(s) de mídia abrem com a senha"

  # Uma amostra baixada e decifrada de verdade (arquivos pequenos e um teto de bytes), para o
  # tamanho do backup não decidir quanto tempo a prova leva.
  mkdir -p "$TMP/midia"
  # A amostra é uma LISTA explícita (os 5 primeiros arquivos de até 50 MB), baixada com
  # --files-from. A primeira versão limitava por bytes (--max-transfer): o rclone abandonava a
  # cópia no meio e depois falhava ao ajustar a data das pastas que tinha criado ("chtimes … no
  # such file") — um backup BOM reprovava assim que a mídia passava do teto. Achado pela prova
  # real contra o Storage (485 MB), que o teste com dublê não tinha como ver.
  rclone_run lsf midiacripto: -R --files-only --max-size 50M > "$TMP/lista-da-midia.txt" 2>/dev/null \
    || reprovar "Não consegui listar os arquivos de mídia pela cifra."
  head -n 5 "$TMP/lista-da-midia.txt" > "$TMP/amostra.txt"
  if [ -s "$TMP/amostra.txt" ]; then
    local saida_amostra
    saida_amostra="$(rclone_run copy midiacripto: /saida/midia --files-from /saida/amostra.txt 2>&1)" \
      || reprovar "Não consegui baixar uma amostra da mídia: $(printf '%s' "$saida_amostra" | tail -n 3 | tr '\n' ' ')"
  fi
  local baixados; baixados="$(find "$TMP/midia" -type f | wc -l | tr -d ' ')"
  if [ "$baixados" -gt 0 ]; then
    c_grn "✓ baixei e decifrei $baixados arquivo(s) de amostra"
  else
    c_ylw "⚠ nenhum arquivo de até 50 MB para amostrar — a mídia abre, mas não conferi o conteúdo."
  fi
}

main() {
  local chave="" env_arq=".env" em="" a
  while [ $# -gt 0 ]; do
    case "$1" in
      --chave-privada) shift; chave="${1:-}" ;;
      --env) shift; env_arq="${1:-}" ;;
      --em) shift; em="${1:-}" ;;
      *) die "Opção desconhecida: $1" ;;
    esac
    shift
  done
  [ -n "$chave" ] || die "Informe a chave PRIVADA: --chave-privada /caminho/age.key"
  [ -f "$chave" ] || die "Não achei a chave privada em '$chave'."
  [ -f "$env_arq" ] || die "Não achei o arquivo de configuração '$env_arq' (use --env)."
  command -v age >/dev/null 2>&1 || die "Falta o 'age'."
  command -v docker >/dev/null 2>&1 || die "Falta o Docker."
  if [ -n "$(find "$chave" -perm /077 2>/dev/null)" ]; then
    c_ylw "⚠ a chave privada está legível por outros usuários — faça: chmod 600 '$chave'"
  fi

  load_env "$env_arq"
  [ -n "${BACKUP_FORA_DESTINO:-}" ] || die "BACKUP_FORA_DESTINO não está em '$env_arq'."
  local destino="${BACKUP_FORA_DESTINO%/}"

  umask 077
  TMP="$(mktemp -d)"
  trap limpar EXIT

  step "Qual backup?"
  if [ -z "$em" ]; then
    em="$(rclone_run lsf "$destino" --dirs-only 2>/dev/null | tr -d '/\r' | grep -E '^[0-9]{8}-[0-9]{6}$' | sort | tail -1 || true)"
    [ -n "$em" ] || reprovar "Não há NENHUM backup em '$destino'."
  fi
  c_grn "✓ usando o backup $em"

  step "Baixando e conferindo o que chegou"
  mkdir -p "$TMP/baixado"
  rclone_run copy "$destino/$em" /saida/baixado >/dev/null 2>&1 || reprovar "Não consegui baixar '$destino/$em'."
  local manifesto="$TMP/baixado/MANIFEST-$em.txt"
  [ -f "$manifesto" ] || reprovar "O backup não tem manifesto — foi interrompido no meio."
  local linha arq esperado atual achou_banco=0
  while IFS= read -r linha; do
    case "$linha" in *"sha256:"*) ;; *) continue ;; esac
    arq="${linha%% *}"
    esperado="${linha##*sha256:}"
    [ -f "$TMP/baixado/$arq" ] || reprovar "O manifesto lista '$arq', que não chegou."
    atual="$(sha256sum "$TMP/baixado/$arq" | cut -d' ' -f1)"
    [ "$atual" = "$esperado" ] || reprovar "'$arq' está corrompido (hash não confere com o manifesto)."
    case "$arq" in db-*) achou_banco=1 ;; esac
  done < "$manifesto"
  [ "$achou_banco" = 1 ] || reprovar "O manifesto não lista o dump do banco."
  c_grn "✓ todos os arquivos conferem com o manifesto"

  step "Decifrando o .env (só para provar que a chave abre)"
  # Em variável, e não `age | head | grep`: o `head` fecha o pipe cedo, o `age` leva
  # SIGPIPE, e com `pipefail` um backup BOM seria reprovado. O conteúdo fica só na
  # memória deste processo e nunca é impresso.
  local decifrado
  decifrado="$(age -d -i "$chave" "$TMP/baixado/env-$em.age" 2>/dev/null)" \
    || reprovar "A chave privada NÃO abre o .env do backup — é a chave errada, ou o backup foi cifrado para outra."
  case "$decifrado" in *=*) ;; *) reprovar "O .env decifrou, mas veio vazio ou ilegível." ;; esac
  decifrado=""
  c_grn "✓ a chave privada abre o backup"

  step "Subindo um Postgres descartável"
  CONTAINER="elevcrm-restauracao-$$"
  docker run -d --rm --name "$CONTAINER" -e POSTGRES_PASSWORD=descartavel "$PG_IMAGE" >/dev/null \
    || reprovar "Não consegui subir o Postgres descartável ($PG_IMAGE)."
  local i
  for i in $(seq 1 60); do
    docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
    [ "$i" -lt 60 ] || reprovar "O Postgres descartável não ficou pronto."
  done
  # O chão que o dump supõe e um Postgres comum não tem: os papéis do Supabase (as
  # policies são `TO authenticated`...) e o schema `extensions`, onde o Supabase instala
  # pgcrypto/uuid-ossp (os DEFAULTs são `extensions.gen_random_bytes(...)`). Sem isto uma
  # tabela inteira deixava de ser criada e a comparação com o banco vivo reprovava um
  # backup BOM — achado pela prova real, não pelo teste com dublê. NÃO são os stubs de
  # auth/storage do selfhost-prelude.sql: esses colidiriam com as tabelas que o dump cria.
  psql_descartavel -v ON_ERROR_STOP=0 >/dev/null 2>&1 <<'PRELUDIO' || true
-- elevcrm: prelúdio da restauração
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role','authenticator','supabase_admin',
                           'supabase_auth_admin','supabase_storage_admin','dashboard_user','pgbouncer']
  loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
PRELUDIO

  step "Restaurando o dump (decifra → descomprime → carrega, sem arquivo em claro)"
  local erros="$TMP/erros.txt"
  age -d -i "$chave" "$TMP/baixado/db-$em.sql.gz.age" 2>/dev/null | gunzip 2>/dev/null \
    | psql_descartavel -v ON_ERROR_STOP=0 >/dev/null 2>"$erros" || true
  local n_erros; n_erros="$(grep -c 'ERROR:' "$erros" 2>/dev/null || true)"; n_erros="${n_erros:-0}"
  c_dim "  $n_erros erro(s) durante a carga (esperados: extensões/roles do Supabase que um Postgres comum não tem)"
  if [ "$n_erros" -gt 0 ]; then
    grep 'ERROR:' "$erros" | sed 's/^[^E]*ERROR:  *//' | sort | uniq -c | sort -rn | head -8 | sed 's/^/    /'
  fi

  step "Conferindo o que voltou"
  local tabelas
  tabelas="$(psql_descartavel -At -c "$SQL_TABELAS" 2>/dev/null || echo 0)"
  [ "${tabelas:-0}" -gt 0 ] || reprovar "Nada foi restaurado: o schema public está vazio. O dump não carrega."
  c_grn "✓ $tabelas tabelas no schema public do banco restaurado"

  local t linhas
  for t in $TABELAS_QUE_IMPORTAM; do
    linhas="$(psql_descartavel -At -c "select count(*) from public.$t" 2>/dev/null || echo '?')"
    printf '    %-18s %s linha(s)\n' "$t" "$linhas"
  done

  if [ -n "${SUPABASE_DB_URL:-}${SUPABASE_DB_ADMIN_URL:-}" ]; then
    step "Comparando com o banco vivo (só leitura)"
    local vivo
    vivo="$(PGURL="$(url_do_schema)" SQL="$SQL_TABELAS" docker run --rm -e PGURL -e SQL "$PG_ALPINE" \
      sh -c 'psql "$PGURL" -At -c "$SQL"' 2>/dev/null || true)"
    if [ -z "$vivo" ]; then
      c_ylw "⚠ não consegui consultar o banco vivo — comparação pulada."
    elif [ "$vivo" != "$tabelas" ]; then
      reprovar "O backup tem $tabelas tabelas no public e o banco vivo tem $vivo. Falta tabela (ou o backup é de outra versão do schema)."
    else
      c_grn "✓ mesmo número de tabelas que o banco vivo ($vivo)"
    fi
  else
    c_dim "  (sem SUPABASE_DB_URL no .env: não comparei com o banco vivo)"
  fi

  provar_a_midia

  printf '\n'
  c_grn "BACKUP PROVADO: $em decifra, descomprime e restaura ($tabelas tabelas)."
  c_dim "  Lembrete: isto não substitui o ensaio trimestral de restauração num Supabase descartável."
}

# RESTAURACAO_LIB=1 carrega só as funções (o teste); sem ele, executa.
if [ -z "${RESTAURACAO_LIB:-}" ]; then main "$@"; fi
