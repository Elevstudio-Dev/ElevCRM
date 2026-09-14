#!/usr/bin/env bash
#
# elev:testar — roda TODOS os testes que a Definition of Done exige, na ordem,
# e imprime um veredito por camada. É o "rodar tudo" desta máquina.
#
# ═══ POR QUE ESTE SCRIPT EXISTE ═══
#
# `pnpm gov:verify` NÃO cobre `test:db` nem `test:e2e` (CLAUDE.md, linha 10):
# verde ali não prova mudança de schema nem de UI. Em 2026-09-12 a `main`
# ficou quatro dias com a E2E vermelha porque cada sessão rodava "o recorte
# que parecia relevante" — e ninguém rodava o conjunto. Este script é o
# conjunto, sem escolha a fazer.
#
# As camadas, na ordem de custo (a barata primeiro, para falhar cedo):
#
#   1. gov:verify   typecheck + lint + lint:channels + lint:role-rank + unitários   ~8 min
#   2. test:db      Postgres efêmero (pg15, o piso) + baseline + invariantes RLS      ~10 min
#   3. test:shell   os guards do kit de instalação e do update                        ~1 min
#   4. E2E          build + seeds do CI + as DUAS listas do CI (SPECS_PARTE_1 e _2)   ~35 min
#
# A E2E roda exatamente o que o CI roda — as listas saem de
# `.github/workflows/e2e.yml`, a mesma fonte que `e2e-cobertura-completa.test.ts`
# lê. `FORA_DO_CI` (vps-fresh-onboarding etc.) fica fora, e é de propósito:
# ver docs/elev/rodar-os-testes.md, seção 3.
#
# Uso:
#   pnpm elev:testar            # tudo
#   pnpm elev:testar --sem-e2e  # só as camadas 1–3 (para uma mudança sem UI)
#
# Sai com código 1 se QUALQUER camada falhar. Os logs ficam em
# .superpowers/testar-tudo/<data>/ — um arquivo por camada, para ler o vermelho
# sem rolar o terminal.
set -u
cd "$(dirname "$0")/.."

SEM_E2E=0
for arg in "$@"; do
  case "$arg" in
    --sem-e2e) SEM_E2E=1 ;;
    *) echo "argumento desconhecido: $arg"; exit 2 ;;
  esac
done

DIR=".superpowers/testar-tudo/$(date +%Y-%m-%d-%H%M)"
mkdir -p "$DIR"
declare -a RESUMO=()
FALHOU=0
INICIO=$(date +%s)

camada() {
  # camada <nome> <comando...>: roda, guarda o log, registra o veredito.
  local nome="$1"; shift
  local log="$DIR/$nome.log"
  local t0=$(date +%s)
  printf '══ %s ════════════════════════════════════════════════════════\n' "$nome"
  if "$@" > "$log" 2>&1; then
    local dt=$(( $(date +%s) - t0 ))
    RESUMO+=("✓ $nome  (${dt}s)")
    echo "  ✓ verde em ${dt}s"
  else
    local dt=$(( $(date +%s) - t0 ))
    RESUMO+=("✗ $nome  (${dt}s)  → $log")
    FALHOU=1
    echo "  ✗ VERMELHO em ${dt}s — últimas linhas de $log:"
    sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -vE '^\s*$' | tail -15 | sed 's/^/    /'
  fi
}

# ─── 1. gov:verify ─────────────────────────────────────────────────────────
camada gov-verify pnpm -s gov:verify

# ─── 2. test:db ────────────────────────────────────────────────────────────
if docker info > /dev/null 2>&1; then
  camada test-db pnpm -s test:db
else
  RESUMO+=("✗ test-db  (docker não responde — abra o Docker Desktop)")
  FALHOU=1
fi

# ─── 3. test:shell ─────────────────────────────────────────────────────────
camada test-shell pnpm -s test:shell

# ─── 4. E2E ────────────────────────────────────────────────────────────────
if [ "$SEM_E2E" -eq 1 ]; then
  RESUMO+=("– e2e  (pulada: --sem-e2e)")
else
  # As listas do CI, lidas do workflow com a MESMA regra do gate
  # `e2e-cobertura-completa`: bloco `CHAVE: >-` seguido de linhas com 8+ espaços.
  lista_do_workflow() {
    # `/^       [ ]+[^ ]/` = 8 ou mais espaços e depois texto — sem `{8,}`,
    # que é intervalo de regex e o mawk do Ubuntu não entende.
    awk -v chave="$1" '
      $0 ~ "^[ ]*" chave ":[ ]*>-[ ]*$" { dentro = 1; next }
      dentro && /^       [ ]+[^ ]/ { print; next }
      dentro { exit }
    ' .github/workflows/e2e.yml | tr -s ' \n' '\n' | grep -E '\.spec\.ts$' | sed 's#^#tests/e2e/#'
  }
  PARTE_1=$(lista_do_workflow SPECS_PARTE_1 | tr '\n' ' ')
  PARTE_2=$(lista_do_workflow SPECS_PARTE_2 | tr '\n' ' ')
  N1=$(printf '%s' "$PARTE_1" | wc -w); N2=$(printf '%s' "$PARTE_2" | wc -w)
  if [ "$N1" -lt 10 ] || [ "$N2" -lt 10 ]; then
    echo "✗ não consegui ler as listas do CI em .github/workflows/e2e.yml (parte 1: $N1, parte 2: $N2)"
    RESUMO+=("✗ e2e  (listas do CI não lidas)")
    FALHOU=1
  else
    echo "E2E: $N1 specs na parte 1, $N2 na parte 2 — as mesmas do CI"
    camada e2e-build pnpm -s e2e:build
    camada e2e-seed pnpm -s elev:semear
    # `--reporter=line` para o log dizer em qual spec parou, como no CI.
    # shellcheck disable=SC2086
    camada e2e-parte-1 pnpm exec playwright test --workers=1 --reporter=line $PARTE_1
    # shellcheck disable=SC2086
    camada e2e-parte-2 pnpm exec playwright test --workers=1 --reporter=line $PARTE_2
  fi
fi

# ─── Veredito ──────────────────────────────────────────────────────────────
TOTAL=$(( $(date +%s) - INICIO ))
echo
echo "══ Veredito ($((TOTAL / 60)) min) ═══════════════════════════════════════════"
printf '  %s\n' "${RESUMO[@]}"
echo "  logs: $DIR/"
if [ "$FALHOU" -eq 0 ]; then
  echo "  TUDO VERDE — a Definition of Done está provada nesta máquina."
else
  echo "  HÁ VERMELHO — leia o log da camada antes de dizer que passou."
fi
exit "$FALHOU"
