#!/usr/bin/env bash
# Backup FORA da VPS: banco + .env + sessões do WhatsApp, CIFRADOS e enviados para um
# armazenamento que não é este servidor.
#
#   bash hostgator-setup-kit/backup-fora.sh            # o backup de verdade
#   bash hostgator-setup-kit/backup-fora.sh --teste    # confere destino, escrita e a trava, sem backup
#
# Roda sozinho todo dia (cron ligado pelo install.sh/update.sh quando o .env tem o
# destino e a chave pública). Quem restaura e prova o backup é o testar-restauracao.sh.
#
# ── Por que isto existe ao lado do backup.sh ────────────────────────────────
# O backup.sh grava NO MESMO DISCO da VPS. Se o servidor morrer, o backup morre junto.
# E ele não leva o .env — onde moram as chaves que decifram o que o banco guarda
# cifrado (CPF, credenciais de IA, tokens do canal oficial). Banco restaurado sem
# essas chaves é um banco cheio de dado ilegível.
#
# ── O que vai para fora, e o que NUNCA vai ──────────────────────────────────
#   vai:    dump do banco, o .env, as sessões do WhatsApp (se houver), um manifesto
#   nunca:  nada em texto aberto. Cada arquivo nasce JÁ cifrado, num pipe
#           (`pg_dump | gzip | age`) — não existe arquivo temporário com o dado em claro
#           que um disco cheio, uma queda ou um `ls` pudesse deixar para trás.
#
# ── Quem decifra ────────────────────────────────────────────────────────────
# Só quem tem a chave PRIVADA (age-keygen), que fica com o dono e NUNCA nesta VPS.
# Aqui há só a pública (BACKUP_AGE_RECIPIENT). Uma VPS invadida entrega o que ela já
# lê, mas não entrega os backups antigos guardados fora.
#
# ── Quem apaga ──────────────────────────────────────────────────────────────
# Ninguém, daqui. A chave de acesso ao armazenamento deve poder ESCREVER e LISTAR e não
# APAGAR, e o bucket deve ter trava de retenção. Assim, quem invadir esta VPS também
# não destrói os backups. O `--teste` tenta apagar de propósito e AVISA se conseguir.
# A expiração dos backups velhos é regra do bucket (lifecycle), não deste script.
#
# ── Configuração (no .env) ──────────────────────────────────────────────────
#   BACKUP_FORA_DESTINO     remoto do rclone + pasta, ex.: fora:meu-bucket/elevcrm
#   BACKUP_AGE_RECIPIENT    chave pública age (age1…); várias separadas por vírgula
#   RCLONE_CONFIG_FORA_*    credenciais do remoto "fora" (o rclone lê direto do ambiente)
#   BACKUP_RCLONE_IMAGE     (opcional) imagem do rclone
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=_common.sh
source "$KIT_DIR/_common.sh"

RCLONE_IMAGE="${BACKUP_RCLONE_IMAGE:-rclone/rclone:1.68.2}"
PG_IMAGE="${BACKUP_PG_IMAGE:-postgres:17-alpine}"
STAGING=""
TS=""

falhar() {  # falhar <mensagem> — deixa o rastro para o monitor e para quem for investigar
  local msg="$1"
  c_red "✖ $msg"
  [ -n "${PROJECT_DIR:-}" ] && printf '%s %s\n' "$(date -u +%FT%TZ)" "$msg" > "$PROJECT_DIR/.backup-fora.fail" 2>/dev/null || true
  exit 1
}

limpar() { [ -n "$STAGING" ] && rm -rf "$STAGING"; return 0; }

# O rclone roda em contêiner (o kit não exige nada além do Docker, como no pg_dump). As
# credenciais entram por NOME (`-e NOME`, o valor vem do ambiente): nunca na linha de
# comando, onde um `ps` as mostraria.
rclone_run() {
  local env_args=() nome
  while IFS= read -r nome; do [ -n "$nome" ] && env_args+=(-e "$nome"); done < <(compgen -e | grep '^RCLONE_CONFIG_' || true)
  local mount=()
  [ -n "$STAGING" ] && mount=(-v "$STAGING:/dados:ro")
  docker run --rm "${env_args[@]+"${env_args[@]}"}" "${mount[@]+"${mount[@]}"}" "$RCLONE_IMAGE" "$@"
}

validar_config() {
  backup_fora_configurado || falhar "Falta BACKUP_FORA_DESTINO e/ou BACKUP_AGE_RECIPIENT no .env (docs/runbooks/operacao-24h.md)."
  case "$BACKUP_FORA_DESTINO" in *:*) ;; *) falhar "BACKUP_FORA_DESTINO precisa ser 'remoto:bucket/pasta' (ex.: fora:meu-bucket/elevcrm).";; esac
  AGE_ARGS=()
  local r
  for r in ${BACKUP_AGE_RECIPIENT//,/ }; do
    # Só chave PÚBLICA age. Um segredo (AGE-SECRET-KEY-…) colado aqui por engano
    # deixaria a chave que decifra tudo dentro do servidor.
    case "$r" in
      AGE-SECRET-KEY-*) falhar "BACKUP_AGE_RECIPIENT tem uma chave PRIVADA. Ponha só a pública (age1…) e guarde a privada fora desta VPS." ;;
    esac
    printf '%s' "$r" | grep -Eq '^age1[a-z0-9]{50,}$' || falhar "BACKUP_AGE_RECIPIENT inválido: esperava uma chave pública age (age1…)."
    AGE_ARGS+=(-r "$r")
  done
  command -v age >/dev/null 2>&1 || falhar "Falta o 'age' no servidor (apt-get install age, ou rode preparar-host.sh)."
  command -v docker >/dev/null 2>&1 || falhar "Falta o Docker."
  command -v flock >/dev/null 2>&1 || falhar "Falta o 'flock' (pacote util-linux)."
}

acessar_destino() {
  # Só a raiz (remoto:bucket): o prefixo é virtual no armazenamento de objetos e pode
  # nem existir antes do primeiro envio.
  local raiz="${BACKUP_FORA_DESTINO%%/*}"
  rclone_run lsf "$raiz" --max-depth 1 >/dev/null 2>&1 \
    || falhar "Não consegui acessar o destino '$raiz'. Confira as credenciais RCLONE_CONFIG_* e o nome do bucket."
}

# ── Os três artefatos, cada um já cifrado ────────────────────────────────────
produzir_artefatos() {
  step "Dump do banco → cifrado (nada em claro em disco)"
  local alvo="$STAGING/db-$TS.sql.gz.age"
  # PGURL por ambiente, e não argumento: a connection string tem a senha do banco.
  if ! PGURL="$(url_do_schema)" docker run --rm -e PGURL "$PG_IMAGE" \
        sh -c 'exec pg_dump "$PGURL" --no-owner --no-privileges' \
      | gzip | age "${AGE_ARGS[@]}" > "$alvo"; then
    falhar "O dump do banco falhou."
  fi
  # Um dump vazio cifrado ainda tem ~200 bytes de cabeçalho; um dump de verdade tem
  # mais. Backup vazio que sobe "com sucesso" é o pior: só aparece na hora de restaurar.
  [ "$(wc -c < "$alvo")" -gt 1000 ] || falhar "O dump do banco saiu vazio ou truncado — não vou enviar um backup que não restaura."
  c_grn "✓ banco: $(du -h "$alvo" | awk '{print $1}')"

  step "O .env (as chaves que decifram o banco) → cifrado"
  age "${AGE_ARGS[@]}" < "$PROJECT_DIR/.env" > "$STAGING/env-$TS.age" || falhar "Não consegui cifrar o .env."
  c_grn "✓ .env cifrado"

  step "Sessões do WhatsApp (canal por QR code) → cifradas"
  local volume; volume="$(nome_do_projeto_atual)_waha-data"
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    if ! docker run --rm -v "$volume:/data:ro" alpine:3.20 tar cz -C /data . \
        | age "${AGE_ARGS[@]}" > "$STAGING/waha-$TS.tgz.age"; then
      falhar "O snapshot das sessões do WhatsApp falhou."
    fi
    c_grn "✓ sessões: $(du -h "$STAGING/waha-$TS.tgz.age" | awk '{print $1}')"
  else
    c_dim "  sem sessões de QR code neste servidor (só canal oficial) — nada a salvar"
  fi

  # O manifesto vai em claro de propósito: ajuda a achar e conferir o backup sem a chave.
  # Não tem segredo (nome, tamanho e hash de arquivos JÁ cifrados).
  {
    echo "elevcrm-backup $TS"
    echo "versao: $(git -C "$PROJECT_DIR" describe --tags --always 2>/dev/null || echo desconhecida)"
    ( cd "$STAGING" && for f in *.age; do printf '%s  %s bytes  sha256:%s\n' "$f" "$(wc -c < "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"; done )
  } > "$STAGING/MANIFEST-$TS.txt"
}

enviar_e_conferir() {
  step "Enviando para fora da VPS → ${BACKUP_FORA_DESTINO%/}/$TS"
  local alvo="${BACKUP_FORA_DESTINO%/}/$TS"
  rclone_run copy /dados "$alvo" --checksum >/dev/null 2>&1 || falhar "O envio para '$alvo' falhou."
  # Conferência pelo que está LÁ, não pelo que o envio disse: hash/tamanho de cada arquivo.
  # `--one-way`: o destino pode ter outras pastas (outros dias); só interessa se o que
  # eu mandei chegou inteiro.
  rclone_run check /dados "$alvo" --one-way >/dev/null 2>&1 || falhar "O que chegou em '$alvo' NÃO confere com o que foi enviado."
  c_grn "✓ enviado e conferido"
}

# O marcador só nasce depois de enviar E conferir — é nele que o monitor.sh confia.
marcar_sucesso() {
  date +%s > "$PROJECT_DIR/.backup-fora.ok"
  rm -f "$PROJECT_DIR/.backup-fora.fail"
}

# ── --teste: destino, escrita e (o que mais importa) a falta de poder de apagar ──
testar_destino() {
  step "Teste do destino (não faz backup)"
  acessar_destino
  c_grn "✓ consigo acessar o destino"

  local objeto="${BACKUP_FORA_DESTINO%/}/_teste/$TS.txt" dir; dir="$(mktemp -d)"
  STAGING="$dir"
  printf 'teste do backup-fora %s\n' "$TS" > "$dir/$TS.txt"
  rclone_run copy /dados "${BACKUP_FORA_DESTINO%/}/_teste" >/dev/null 2>&1 \
    || falhar "Não consegui ESCREVER no destino. A chave precisa da permissão de escrita."
  c_grn "✓ consigo escrever"

  if rclone_run deletefile "$objeto" >/dev/null 2>&1; then
    c_ylw "⚠ A chave consegue APAGAR o que enviou. Quem invadir esta VPS apaga os backups também."
    c_ylw "  Crie uma chave sem a permissão de apagar e ligue a trava de retenção do bucket"
    c_ylw "  (docs/runbooks/operacao-24h.md). O backup funciona assim, mas não está protegido."
  else
    c_grn "✓ a chave NÃO consegue apagar (é o que se quer) — o backup resiste a quem invadir esta VPS"
  fi
}

main() {
  local modo=backup a
  for a in "$@"; do
    case "$a" in
      --teste) modo=teste ;;
      *) die "Opção desconhecida: $a (use --teste ou nenhuma)" ;;
    esac
  done
  enter_project
  validar_config

  # Um backup por vez: o cron das 03:17 não pode atropelar um backup manual em curso.
  exec 9>"$PROJECT_DIR/.backup-fora.lock"
  flock -n 9 || { c_ylw "Já há um backup fora da VPS em andamento — saindo."; exit 0; }

  TS="${BACKUP_FORA_TS:-$(date -u +%Y%m%d-%H%M%S)}"
  trap limpar EXIT

  if [ "$modo" = teste ]; then testar_destino; return 0; fi

  acessar_destino
  umask 077
  STAGING="$(mktemp -d "$PROJECT_DIR/.backup-fora-tmp.XXXXXX")"
  produzir_artefatos
  enviar_e_conferir
  marcar_sucesso
  c_grn "✓ backup fora da VPS concluído ($TS)"
}

# BACKUP_FORA_LIB=1 carrega só as funções (o teste); sem ele, executa.
if [ -z "${BACKUP_FORA_LIB:-}" ]; then main "$@"; fi
