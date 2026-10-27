#!/usr/bin/env bash
# Troca o domínio de uma instalação que JÁ está no ar — por exemplo, do endereço provisório da
# hospedagem para o domínio da empresa.
#
#   bash hostgator-setup-kit/trocar-dominio.sh --dominio crm.suaempresa.com.br
#   bash hostgator-setup-kit/trocar-dominio.sh --dominio crm.suaempresa.com.br --ensaio   # só confere
#
# ── O que ele faz, na ordem ──────────────────────────────────────────────────────────────────
#   1. Confere que o NOME NOVO já aponta para ESTA VPS. Sem isso o Caddy não consegue emitir o
#      certificado e o site cairia — por isso é a primeira coisa, antes de qualquer escrita.
#   2. Guarda uma cópia do `.env` (permissão 600) e troca as TRÊS chaves que carregam o domínio:
#      DOMAIN, NEXT_PUBLIC_APP_URL e NEXT_PUBLIC_ADMIN_URL.
#   3. Recria os contêineres e espera o HTTPS novo responder 200. Se não responder, VOLTA ao
#      `.env` anterior e recria de novo: o site fica no endereço de antes, e o script diz isso.
#   4. Reescreve a linha do cron que chama o app pelo endereço (o `event-log-drain`) — ela carrega
#      o domínio na URL, e uma linha esquecida bateria para sempre no endereço velho.
#
# ── O que ele NÃO faz (e diz no fim) ─────────────────────────────────────────────────────────
# O endereço ANTIGO deixa de responder: o Caddy atende um nome só. Para uma instalação sem
# clientes isso não custa nada; com clientes, avise-os antes.
#
# E o que mora FORA da VPS ele não alcança: o Site URL e os Redirect URLs do Supabase (o link do
# e-mail de confirmação/recuperação de senha usa esses) e qualquer integração que tenha gravado o
# endereço antigo (Google, Meta). O fim da execução lista o que conferir.
# NUNCA pela entrada padrão (`ssh host bash -s < trocar-dominio.sh`): o `bash -s` lê o script
# aos pedaços da própria entrada, e o `docker compose exec` que confere a saúde do app a CONSOME —
# o resto do script some, sem erro, no meio da troca (medido numa VPS real: o `.env` já trocado,
# contêineres recriados e o cron e a reversão nunca executados). Por isso exijo um arquivo.
[ -f "$0" ] || {
  printf '✖ Este script precisa rodar a partir de um ARQUIVO, não da entrada padrão (bash -s).\n' >&2
  printf '  Copie-o para a máquina (scp) e rode: cd <pasta do projeto> && bash /caminho/trocar-dominio.sh --dominio ...\n' >&2
  exit 1
}
# O kit é o da pasta do arquivo — ou, quando o arquivo foi copiado para fora do kit (operar uma VPS
# cuja versão instalada ainda não o traz), o da pasta do projeto onde o comando foi dado.
AQUI="$(dirname "$0")"
[ -f "$AQUI/_common.sh" ] || AQUI="hostgator-setup-kit"
source "$AQUI/_common.sh"
# `crontab_atual` entrou depois de algumas versões instaladas: sem ele, `crontab -l` de uma conta
# sem crontab sai 1 e o `pipefail` mata o script no meio.
declare -F crontab_atual >/dev/null || crontab_atual() { crontab -l 2>/dev/null || true; }

uso() {
  printf 'Uso: bash hostgator-setup-kit/trocar-dominio.sh --dominio <novo.dominio.com.br> [--ensaio]\n'
}

NOVO=""; ENSAIO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dominio) [ $# -ge 2 ] || die "--dominio pede um valor."; NOVO="$2"; shift 2;;
    --ensaio)  ENSAIO=1; shift;;
    -h|--help) uso; exit 0;;
    *)         uso; die "Argumento desconhecido: $1";;
  esac
done

NOVO="$(printf '%s' "$NOVO" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
[ -n "$NOVO" ] || { uso; die "Informe o domínio novo."; }

# Só o NOME: sem https://, sem barra, sem porta. O que o Caddy e o Let's Encrypt aceitam.
dominio_valido() {
  [ "${#1}" -le 253 ] && [[ "$1" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]
}
dominio_valido "$NOVO" || die "'$NOVO' não é um domínio válido. Digite só o nome, sem https:// nem barra — ex.: crm.suaempresa.com.br"

enter_project

ATUAL="$(valor_do_env .env DOMAIN)"
[ -n "$ATUAL" ] || die "O .env não tem DOMAIN — esta instalação não parece ter terminado de instalar."

if [ "$NOVO" = "$ATUAL" ]; then
  c_grn "✓ Esta instalação já usa ${NOVO}. Nada a trocar."
  exit 0
fi

# As URLs públicas só são trocadas se forem EXATAMENTE o domínio atual. Uma instalação com o painel
# de admin em outro endereço de propósito, ou com a URL pública editada à mão, não pode ter isso
# reescrito em silêncio — esse é o tipo de surpresa que só aparece quando alguém não consegue entrar.
for chave in NEXT_PUBLIC_APP_URL NEXT_PUBLIC_ADMIN_URL; do
  v="$(valor_do_env .env "$chave")"
  if [ -n "$v" ] && [ "$v" != "https://${ATUAL}" ]; then
    die "O .env tem ${chave} diferente do DOMAIN (${ATUAL}). Não troco no escuro — acerte essa chave à mão e rode de novo."
  fi
done

step "Conferindo o DNS de ${NOVO}"
ip_publico="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo '')"
[ -n "$ip_publico" ] || die "Não consegui descobrir o IP público desta VPS (sem resposta de api.ipify.org). Tente de novo em instantes."
# `ahostsv4`: o A-record é o que o Let's Encrypt usa. Pode haver mais de um endereço; basta que um
# seja o desta VPS (mesma regra do instalador).
resolvido="$(getent ahostsv4 "$NOVO" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
case " $resolvido " in
  *" $ip_publico "*) c_grn "✓ ${NOVO} → ${ip_publico} (aponta para esta VPS)";;
  *)
    c_red "✖ ${NOVO} resolve para '${resolvido:-nada}', e o IP desta VPS é ${ip_publico}."
    printf '  No painel do DNS do domínio, o registro A de %s precisa apontar para %s.\n' "$NOVO" "$ip_publico"
    printf '  DNS recém-criado leva de alguns minutos a algumas horas. Nada foi alterado.\n'
    exit 1;;
esac
# AAAA: se o nome tiver IPv6 que não é desta VPS, o Let's Encrypt tenta por ele primeiro e a
# emissão do certificado falha mesmo com o A-record certo. (`::ffff:` é o IPv4 "mapeado" que o
# getent devolve quando o nome só tem A — não é um AAAA de verdade.)
aaaa="$(getent ahostsv6 "$NOVO" 2>/dev/null | awk '{print $1}' | sort -u | { grep -v '^::ffff:' || true; } | tr '\n' ' ')"
if [ -n "${aaaa// /}" ]; then
  c_red "✖ ${NOVO} tem registro AAAA (IPv6): ${aaaa}"
  printf '  O Let'"'"'s Encrypt tenta o IPv6 primeiro e esta VPS não responde por ele. Remova o AAAA no painel do\n'
  printf '  DNS (ou aponte para o IPv6 desta VPS) e rode de novo. Nada foi alterado.\n'
  exit 1
fi

if [ "$ENSAIO" = 1 ]; then
  c_grn "✓ Ensaio: o DNS está certo. Com isto, a troca seria:"
  printf '    DOMAIN                 %s → %s\n' "$ATUAL" "$NOVO"
  printf '    NEXT_PUBLIC_APP_URL    https://%s → https://%s\n' "$ATUAL" "$NOVO"
  printf '    NEXT_PUBLIC_ADMIN_URL  https://%s → https://%s\n' "$ATUAL" "$NOVO"
  printf '    cron do event-log-drain reescrito para o endereço novo.\n  Nada foi alterado.\n'
  exit 0
fi

# Outras chaves que ainda citam o endereço velho — só os NOMES, o valor pode ser segredo.
outras="$({ grep -F -- "$ATUAL" .env || true; } | { grep -vE '^(DOMAIN|NEXT_PUBLIC_APP_URL|NEXT_PUBLIC_ADMIN_URL)=' || true; } | cut -d= -f1 | tr '\n' ' ')"

step "Guardando uma cópia do .env"
COPIA=".env.bak-dominio-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p .env "$COPIA"
chmod 600 "$COPIA"
c_grn "✓ ${COPIA}"

voltar_atras() {
  c_ylw "↩ Voltando ao endereço anterior (${ATUAL})…"
  cp -p "$COPIA" .env
  chmod 600 .env
  load_env .env
  dc up -d >/dev/null 2>&1 || true
}

step "Trocando o domínio no .env"
set_env_var .env DOMAIN "\"${NOVO}\""
set_env_var .env NEXT_PUBLIC_APP_URL "\"https://${NOVO}\""
set_env_var .env NEXT_PUBLIC_ADMIN_URL "\"https://${NOVO}\""
load_env .env
c_grn "✓ DOMAIN, NEXT_PUBLIC_APP_URL e NEXT_PUBLIC_ADMIN_URL agora apontam para ${NOVO}"

step "Recriando os contêineres (o Caddy pede o certificado novo)"
if ! dc up -d; then
  voltar_atras
  die "Não consegui recriar os contêineres. O .env voltou ao de antes."
fi

step "Esperando https://${NOVO} responder"
codigo=""
for _ in $(seq 1 30); do
  # `|| true` por dentro: o curl sai não-zero quando o TLS ainda não está pronto, e isso é o
  # estado NORMAL dos primeiros segundos — não pode matar o laço pelo `set -e`.
  codigo="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://${NOVO}/login" 2>/dev/null || true)"
  [ "$codigo" = "200" ] && break
  sleep 5
done
if [ "$codigo" != "200" ]; then
  c_red "✖ https://${NOVO}/login não respondeu 200 (último código: ${codigo:-nenhum})."
  printf '  Logs do Caddy: docker compose %s logs --tail=40 caddy\n' "$(dc_files)"
  voltar_atras
  die "A troca NÃO ficou: o site segue em https://${ATUAL}."
fi
c_grn "✓ https://${NOVO} responde 200 com certificado válido"

step "Conferindo a saúde do app"
if ! wait_app_healthy 20 3 >/dev/null; then
  voltar_atras
  die "O app não ficou saudável no domínio novo. A troca NÃO ficou: o site segue em https://${ATUAL}."
fi
c_grn "✓ app saudável"

# O cron que chama o app por HTTP leva o domínio na URL. A assinatura legada é a URL VELHA: é o que
# o `cron_merge` usa para remover a linha anterior mesmo que ela tenha sido escrita antes de o
# marcador existir. Não chamo `setup_event_log_drain_cron` porque, para uma URL "nova", ela
# repetiria a higienização de eventos da primeira ativação — que aqui não é a primeira.
if command -v crontab >/dev/null 2>&1; then
  segredo="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
  if [ -n "$segredo" ]; then
    url_velha="https://${ATUAL}/api/v1/cron/event-log-drain"
    url_nova="https://${NOVO}/api/v1/cron/event-log-drain"
    marcador="$(cron_tag drain)"
    linha="* * * * * curl -fsS -H \"Authorization: Bearer ${segredo}\" \"${url_nova}\" >/dev/null 2>&1 ${marcador}"
    ( crontab_atual | cron_merge "$marcador" "$url_velha" "$linha" ) | crontab -
    c_grn "✓ cron do event-log-drain agora chama ${NOVO}"
  fi
fi

if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  step "Atualizando o Site URL e os e-mails de acesso no Supabase"
  bash "$AQUI/marca-emails.sh" || c_ylw "⚠ marca-emails.sh falhou — acerte o Site URL à mão (abaixo)."
fi

printf '\n'
c_grn "✓ Pronto: https://${NOVO}"
printf '\nO que ficou FORA da VPS (o script não alcança) — confira:\n'
printf '  1. Supabase → Authentication → URL Configuration:\n'
printf '       Site URL:       https://%s\n' "$NOVO"
printf '       Redirect URLs:  https://%s/auth/confirm   (mantenha também a antiga até testar o e-mail de recuperação)\n' "$NOVO"
printf '  2. O endereço antigo (%s) deixou de responder.\n' "$ATUAL"
printf '  3. Quem estava logado precisa entrar de novo: o cookie de sessão é do endereço antigo.\n'
if [ -n "${outras// /}" ]; then
  printf '  4. Estas chaves do .env ainda citam o endereço antigo e eu não mexi: %s\n' "$outras"
fi
printf '  Integrações que gravaram o endereço (login com Google, webhook da Meta) precisam do endereço novo.\n'
printf '\nA cópia do .env anterior ficou em %s (permissão 600). Apague-a quando confirmar que está tudo certo.\n' "$COPIA"
