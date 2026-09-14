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
# As camadas:
#
#   1. gov:verify   typecheck + lint + lint:channels + lint:role-rank + unitários   ~6 min  ┐ em paralelo:
#   2. test:db      Postgres efêmero (pg15, o piso) + baseline + invariantes RLS      ~9 min  ┘ não dividem estado
#   3. test:shell   os guards do kit de instalação e do update                        ~1 min
#   4. E2E          build + seeds do CI + as DUAS listas do CI (SPECS_PARTE_1 e _2)   ~30 min
#
# A E2E roda exatamente o que o CI roda: as listas vêm de
# `scripts/listas-do-ci.ts` — o MESMO parser que o gate
# `e2e-cobertura-completa.test.ts` usa —, e o passo exporta as duas variáveis
# que o `e2e.yml` define por fora do `.env.e2e` (`AUTH_RATE_LIMIT_LOGIN_IP`,
# porque todas as specs logam do mesmo IP, e `SENTRY_DSN=off`). `FORA_DO_CI`
# (vps-fresh-onboarding etc.) fica fora, e é de propósito: ver
# docs/elev/rodar-os-testes.md, seção 3.
#
# Se o BUILD ou o SEED da E2E falhar, as duas partes NÃO rodam: o Playwright
# subiria `next start` sobre o `.next` da rodada anterior e o veredito
# atribuiria ao código de hoje o resultado do código de ontem.
#
# Uso:
#   pnpm elev:testar            # tudo
#   pnpm elev:testar --sem-e2e  # só as camadas 1–3 (para uma mudança sem UI)
#
# Sai com código 1 se QUALQUER camada falhar. Os logs ficam em
# .superpowers/testar-tudo/<data-hora>/ — um arquivo por camada, sem cor, para
# ler o vermelho com `grep` em vez de rolar o terminal.
set -u
cd "$(dirname "$0")/.."

# Sem cor nos logs: vitest, playwright e pnpm colorizam mesmo sem TTY, e um
# `grep failed` não casa com escape ANSI no meio.
export NO_COLOR=1 FORCE_COLOR=0

SEM_E2E=0
for arg in "$@"; do
  case "$arg" in
    --sem-e2e) SEM_E2E=1 ;;
    *) echo "argumento desconhecido: $arg"; exit 2 ;;
  esac
done

DIR=".superpowers/testar-tudo/$(date +%Y-%m-%d-%H%M%S)"
mkdir -p "$DIR"
declare -a RESUMO=()
FALHOU=0
INICIO=$(date +%s)

# registrar <nome> <rc> <t0>: escreve o veredito de uma camada já terminada.
registrar() {
  local nome="$1" rc="$2" t0="$3"
  local dt=$(( $(date +%s) - t0 ))
  local log="$DIR/$nome.log"
  if [ "$rc" -eq 0 ]; then
    RESUMO+=("✓ $nome  (${dt}s)")
    echo "  ✓ $nome verde em ${dt}s"
  else
    RESUMO+=("✗ $nome  (${dt}s)  → $log")
    FALHOU=1
    echo "  ✗ $nome VERMELHO em ${dt}s — últimas linhas de $log:"
    grep -vE '^\s*$' "$log" | tail -15 | sed 's/^/    /'
  fi
  return "$rc"
}

# camada <nome> <comando...>: roda em primeiro plano, guarda o log, registra.
camada() {
  local nome="$1"; shift
  local t0=$(date +%s)
  printf '══ %s ════════════════════════════════════════════════════════\n' "$nome"
  "$@" > "$DIR/$nome.log" 2>&1
  registrar "$nome" "$?" "$t0"
}

# ─── 1 + 2. gov:verify e test:db, em paralelo ───────────────────────────────
# Não compartilham estado (um é CPU, o outro é um Postgres efêmero no Docker);
# em série somavam ~15 min, dos quais ~9 eram espera.
printf '══ gov-verify + test-db (em paralelo) ═══════════════════════════════\n'
T0_DB=$(date +%s)
if docker info > /dev/null 2>&1; then
  pnpm -s test:db > "$DIR/test-db.log" 2>&1 &
  PID_DB=$!
else
  PID_DB=""
  echo "docker não responde — abra o Docker Desktop" > "$DIR/test-db.log"
fi
T0_GOV=$(date +%s)
pnpm -s gov:verify > "$DIR/gov-verify.log" 2>&1
registrar gov-verify "$?" "$T0_GOV"
if [ -n "$PID_DB" ]; then
  wait "$PID_DB"; registrar test-db "$?" "$T0_DB"
else
  registrar test-db 1 "$T0_DB"
fi

# ─── 3. test:shell ─────────────────────────────────────────────────────────
camada test-shell pnpm -s test:shell

# ─── 4. E2E ────────────────────────────────────────────────────────────────
if [ "$SEM_E2E" -eq 1 ]; then
  RESUMO+=("– e2e  (pulada: --sem-e2e)")
else
  PARTE_1=$(pnpm -s exec tsx scripts/listas-do-ci.ts SPECS_PARTE_1 | tr '\n' ' ')
  PARTE_2=$(pnpm -s exec tsx scripts/listas-do-ci.ts SPECS_PARTE_2 | tr '\n' ' ')
  N1=$(printf '%s' "$PARTE_1" | wc -w); N2=$(printf '%s' "$PARTE_2" | wc -w)
  if [ "$N1" -lt 10 ] || [ "$N2" -lt 10 ]; then
    echo "✗ não consegui ler as listas do CI (parte 1: $N1, parte 2: $N2) — veja scripts/listas-do-ci.ts"
    RESUMO+=("✗ e2e  (listas do CI não lidas)")
    FALHOU=1
  else
    echo "E2E: $N1 specs na parte 1, $N2 na parte 2 — as mesmas do CI"
    # O mesmo `env:` do passo do CI (`.github/workflows/e2e.yml`): sem isto o
    # limite de 60 logins por IP em 5 min derruba specs no meio da rodada.
    export AUTH_RATE_LIMIT_LOGIN_IP=1000 SENTRY_DSN=off
    if camada e2e-build pnpm -s e2e:build && camada e2e-seed pnpm -s elev:semear; then
      # `--reporter=line` para o log dizer em qual spec parou, como no CI.
      # shellcheck disable=SC2086
      camada e2e-parte-1 pnpm exec playwright test --workers=1 --reporter=line $PARTE_1
      # shellcheck disable=SC2086
      camada e2e-parte-2 pnpm exec playwright test --workers=1 --reporter=line $PARTE_2
    else
      RESUMO+=("– e2e-parte-1  (não rodou: build ou seed vermelho)")
      RESUMO+=("– e2e-parte-2  (não rodou: build ou seed vermelho)")
    fi
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
