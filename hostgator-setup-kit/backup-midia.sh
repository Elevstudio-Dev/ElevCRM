#!/usr/bin/env bash
# Backup dos ARQUIVOS do Storage — as fotos, os áudios e os documentos que os pacientes
# mandam — CIFRADOS, para fora da VPS.
#
#   bash hostgator-setup-kit/backup-midia.sh            # copia o que é novo
#   bash hostgator-setup-kit/backup-midia.sh --teste    # confere origem, destino, senha e a trava, sem copiar
#
# Roda sozinho todo dia (cron ligado pelo install.sh/update.sh quando o .env tem origem,
# destino e senha). Quem prova que restaura é o testar-restauracao.sh.
#
# ── Por que isto existe ao lado do backup-fora.sh ───────────────────────────
# O backup do BANCO não leva os arquivos. O Supabase restaura a tabela que LISTA os arquivos
# (storage.objects), mas não os arquivos: nem o backup diário, nem o PITR, nem um pg_dump.
# Apagou ou perdeu um arquivo, ele não volta — e a conversa continua apontando para ele. Para
# uma clínica, a foto do paciente é justamente o que não se refaz.
#
# ── Por que é um script à parte ─────────────────────────────────────────────
# O banco é pequeno e cabe num pacote diário. A mídia cresce sem parar e não pode ser re-enviada
# inteira todo dia: aqui a cópia é INCREMENTAL (só o que é novo ou mudou).
#
# ── `copy`, nunca `sync` ────────────────────────────────────────────────────
# `sync` apaga do destino o que sumiu da origem. O Storage do Supabase não tem versionamento:
# arquivo apagado lá some para sempre. Com `copy`, o backup guarda o que já existiu — que é
# exatamente para isso que ele serve. O custo, dito de frente: um arquivo que o paciente pediu
# para apagar (LGPD) continua no backup até o prazo de expiração do bucket vencer.
#
# ── Cifra ───────────────────────────────────────────────────────────────────
# `rclone crypt`: conteúdo E nomes dos arquivos. Quem lê o bucket vê lixo. Diferente do
# backup do banco (age, só a chave pública na VPS), aqui a cifra é simétrica — uma senha, que
# precisa estar nesta VPS para copiar. Ela mora no .env, e o .env é copiado (cifrado com age)
# pelo backup-fora.sh: a senha dos arquivos nunca depende de a VPS sobreviver.
#
# ── Quem apaga ──────────────────────────────────────────────────────────────
# Como no backup-fora.sh: a chave de acesso ao destino deve escrever e listar e NÃO apagar,
# e o bucket deve ter trava de retenção. O `--teste` tenta apagar de propósito e avisa.
#
# ── Configuração (no .env) ──────────────────────────────────────────────────
#   BACKUP_MIDIA_ORIGEM    remoto do rclone que lê o Storage do Supabase, ex.: supamidia:
#                          (lista TODOS os buckets). Credenciais S3 em RCLONE_CONFIG_SUPAMIDIA_*
#                          — Supabase → Storage → S3 Connection. ATENÇÃO: essa chave dá acesso
#                          TOTAL a todos os buckets e ignora as regras de acesso.
#   BACKUP_MIDIA_DESTINO   remoto:bucket/pasta do destino, ex.: fora:meu-bucket/elevcrm-midia
#   BACKUP_MIDIA_SENHA     senha longa (24+ caracteres) que cifra conteúdo e nomes. PERDEU = PERDEU OS ARQUIVOS.
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=_common.sh
source "$KIT_DIR/_common.sh"

RCLONE_IMAGE="${BACKUP_RCLONE_IMAGE:-rclone/rclone:1.68.2}"
STAGING=""
TS=""

falhar() {  # falhar <mensagem> — deixa o rastro para o monitor e para quem for investigar
  local msg="$1"
  c_red "✖ $msg"
  [ -n "${PROJECT_DIR:-}" ] && printf '%s %s\n' "$(date -u +%FT%TZ)" "$msg" > "$PROJECT_DIR/.backup-midia.fail" 2>/dev/null || true
  exit 1
}

limpar() { [ -n "$STAGING" ] && rm -rf "$STAGING"; return 0; }

# Credenciais entram no contêiner por NOME (`-e NOME`), nunca por valor: um `ps` não as mostra.
rclone_run() {
  local env_args=() nome
  while IFS= read -r nome; do [ -n "$nome" ] && env_args+=(-e "$nome"); done < <(compgen -e | grep '^RCLONE_CONFIG_' || true)
  local mount=()
  [ -n "$STAGING" ] && mount=(-v "$STAGING:/dados:ro")
  docker run --rm "${env_args[@]+"${env_args[@]}"}" "${mount[@]+"${mount[@]}"}" "$RCLONE_IMAGE" "$@"
}

# Roda o rclone e, se falhar, leva as últimas linhas da saída para o rastro. Um "falhou" sem
# causa obriga quem investiga a refazer a cópia só para ver o erro — e numa mídia grande isso
# leva horas.
rclone_ou_falhar() {  # rclone_ou_falhar <mensagem se falhar> <args do rclone...>
  local msg="$1" saida; shift
  saida="$(rclone_run "$@" 2>&1)" || falhar "$msg $(printf '%s' "$saida" | tail -n 3 | tr '\n' ' ')"
}

validar_config() {
  backup_midia_configurado || falhar "Falta BACKUP_MIDIA_ORIGEM, BACKUP_MIDIA_DESTINO e/ou BACKUP_MIDIA_SENHA no .env (docs/runbooks/operacao-24h.md)."
  case "$BACKUP_MIDIA_ORIGEM" in *:*) ;; *) falhar "BACKUP_MIDIA_ORIGEM precisa ser um remoto do rclone (ex.: supamidia:).";; esac
  case "$BACKUP_MIDIA_DESTINO" in *:*) ;; *) falhar "BACKUP_MIDIA_DESTINO precisa ser 'remoto:bucket/pasta' (ex.: fora:meu-bucket/elevcrm-midia).";; esac
  # O destino NÃO pode ser a própria origem: copiar o Storage para dentro dele mesmo.
  [ "${BACKUP_MIDIA_DESTINO%%:*}" != "${BACKUP_MIDIA_ORIGEM%%:*}" ] \
    || falhar "BACKUP_MIDIA_DESTINO usa o mesmo remoto da origem — o backup precisa ir para FORA do Supabase."
  # Senha curta é senha adivinhável: os arquivos estão num bucket de terceiros.
  [ "${#BACKUP_MIDIA_SENHA}" -ge 24 ] || falhar "BACKUP_MIDIA_SENHA precisa ter 24 caracteres ou mais (gere uma: openssl rand -base64 32)."
  command -v docker >/dev/null 2>&1 || falhar "Falta o Docker."
  command -v flock >/dev/null 2>&1 || falhar "Falta o 'flock' (pacote util-linux)."
  exportar_cripto_da_midia || falhar "Não consegui preparar a cifra dos arquivos (o rclone não respondeu — o Docker está de pé?)."
}

acessar() {
  # A origem tem de LISTAR buckets. Lista vazia = a chave não enxerga nada, e um backup "ok" de
  # uma origem que não se enxerga é o falso verde de sempre.
  local buckets
  buckets="$(rclone_run lsf "$BACKUP_MIDIA_ORIGEM" --dirs-only 2>/dev/null)" \
    || falhar "Não consegui acessar a origem '$BACKUP_MIDIA_ORIGEM'. Confira o endereço e as chaves RCLONE_CONFIG_* do Storage do Supabase."
  [ -n "$buckets" ] || falhar "A origem '$BACKUP_MIDIA_ORIGEM' não lista nenhum bucket — a chave não tem acesso, ou o endereço está errado."
  rclone_run lsf "${BACKUP_MIDIA_DESTINO%%/*}" --max-depth 1 >/dev/null 2>&1 \
    || falhar "Não consegui acessar o destino '${BACKUP_MIDIA_DESTINO%%/*}'. Confira as credenciais e o nome do bucket."
}

copiar_e_conferir() {
  step "Copiando o que é novo → ${BACKUP_MIDIA_DESTINO%/} (cifrado)"
  # `copy`: só acrescenta e atualiza, nunca apaga do destino. Ver o cabeçalho.
  rclone_ou_falhar "A cópia dos arquivos falhou:" copy "$BACKUP_MIDIA_ORIGEM" midiacripto: \
    --transfers 4 --checkers 8 --retries 3 --low-level-retries 10 --log-level NOTICE
  # Confere pelo que está LÁ: todo arquivo da origem existe no destino, com o mesmo tamanho. (Um
  # hash não serve: o destino é cifrado, então o hash dele nunca é o da origem.)
  rclone_ou_falhar "Algum arquivo da origem NÃO chegou inteiro ao destino:" check "$BACKUP_MIDIA_ORIGEM" midiacripto: \
    --one-way --size-only
  local resumo
  resumo="$(rclone_run size midiacripto: 2>/dev/null | tr '\n' ' ')" || true
  c_grn "✓ copiado e conferido — ${resumo:-sem resumo}"
}

marcar_sucesso() {
  date +%s > "$PROJECT_DIR/.backup-midia.ok"
  rm -f "$PROJECT_DIR/.backup-midia.fail"
}

# --teste: origem, destino, a senha de ponta a ponta e a falta de poder de apagar.
testar() {
  step "Teste da mídia (não copia nada)"
  acessar
  c_grn "✓ consigo ler a origem e acessar o destino"

  local dir; dir="$(mktemp -d)"; STAGING="$dir"
  printf 'teste do backup-midia %s\n' "$TS" > "$dir/$TS.txt"
  rclone_run copyto "/dados/$TS.txt" "midiacripto:_teste/$TS.txt" >/dev/null 2>&1 \
    || falhar "Não consegui ESCREVER no destino. A chave precisa da permissão de escrita."
  c_grn "✓ consigo escrever (cifrado)"

  # Ida e volta pela cifra: se a senha estivesse errada ou a cifra mal montada, o que volta não
  # seria o que foi.
  local volta; volta="$(rclone_run cat "midiacripto:_teste/$TS.txt" 2>/dev/null || true)"
  [ "$volta" = "teste do backup-midia $TS" ] || falhar "O arquivo de teste não voltou igual pela cifra — a senha ou a cifra estão erradas."
  c_grn "✓ o arquivo de teste volta igual pela cifra"

  if rclone_run deletefile "midiacripto:_teste/$TS.txt" >/dev/null 2>&1; then
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

  # Um por vez: o cron das 03:47 não pode atropelar uma cópia manual em curso (ou a de ontem, que
  # numa mídia grande pode ainda estar rodando).
  exec 9>"$PROJECT_DIR/.backup-midia.lock"
  flock -n 9 || { c_ylw "Já há um backup de mídia em andamento — saindo."; exit 0; }

  TS="${BACKUP_MIDIA_TS:-$(date -u +%Y%m%d-%H%M%S)}"
  trap limpar EXIT

  if [ "$modo" = teste ]; then testar; return 0; fi

  acessar
  copiar_e_conferir
  marcar_sucesso
  c_grn "✓ backup dos arquivos de mídia concluído ($TS)"
}

# BACKUP_MIDIA_LIB=1 carrega só as funções (o teste); sem ele, executa.
if [ -z "${BACKUP_MIDIA_LIB:-}" ]; then main "$@"; fi
