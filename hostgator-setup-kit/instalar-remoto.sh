#!/usr/bin/env bash
# Instala o Elev CRM numa VPS que JÁ passou pelo `preparar-host.sh`, a partir da SUA máquina.
#
#   bash hostgator-setup-kit/instalar-remoto.sh --host IP --chave ~/.ssh/CHAVE --dominio crm.exemplo.com.br
#
#   --host IP          a VPS                          (ou ELEV_VPS_HOST)
#   --chave ARQUIVO    sua chave SSH privada          (ou ELEV_VPS_CHAVE)
#   --dominio NOME     o endereço do CRM              (ou ELEV_VPS_DOMINIO)
#   --pasta DIR        onde o kit está na VPS (padrão /opt/elevcrm)
#   --versao vX.Y.Z    leva o kit da VPS para esta versão ANTES de instalar
#   --nome TEXTO       nome do produto na interface (padrão: Elev CRM)
#   --cadastro-aberto  NÃO fecha o cadastro público (o padrão aqui é FECHAR; ver abaixo)
#   --manter-senha-do-dono   não apaga OWNER_PASSWORD do .env da VPS depois de instalar
#   --ensaio           não conecta em NADA: valida o que você digitou e mostra o que enviaria
#
# ── Por que existe ──────────────────────────────────────────────────────────
# O `install.sh` pergunta chaves e senhas. Rodá-lo por SSH "no escuro" por cima de um chat
# (colar a chave do Supabase numa conversa) deixa o segredo em histórico, em log e na tela
# de quem ajuda. Este script lê tudo AQUI, sem eco, e manda para a VPS pela entrada padrão
# do SSH: o segredo nunca vira argumento de comando (então não aparece em `ps`), nunca vai
# para o histórico do shell e nunca passa por terceiros.
#
# ── O que ele recusa, de propósito ──────────────────────────────────────────
#  - sobrescrever um .env que já existe na VPS (apagaria os segredos de cifra: perder
#    CPF_ENCRYPTION_KEY / AI_CRED_AES_KEY é perder dado cifrado do banco);
#  - seguir se o nome não aponta para a VPS (o Let's Encrypt não emite o certificado e o
#    CRM sobe sem HTTPS);
#  - valor com quebra de linha (não cabe em .env sem corromper o resto).
#
# ── Cadastro público ────────────────────────────────────────────────────────
# Esta instalação é feita para atender VÁRIOS clientes, que entram por convite. Por isso
# `CADASTRO_PUBLICO=false` vai no .env: sem ele, qualquer pessoa da internet que abrir
# https://SEU-DOMINIO/signup cria uma empresa dentro da sua instância.
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=_common.sh
source "$KIT_DIR/_common.sh"
set -euo pipefail

HOST="${ELEV_VPS_HOST:-}"; CHAVE="${ELEV_VPS_CHAVE:-}"; DOMINIO="${ELEV_VPS_DOMINIO:-}"
PASTA="/opt/elevcrm"; VERSAO=""; NOME_APP="Elev CRM"
CADASTRO_PUBLICO_VALOR="false"; MANTER_SENHA=0; ENSAIO=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host)    HOST="${2:-}"; shift 2;;
    --chave)   CHAVE="${2:-}"; shift 2;;
    --dominio) DOMINIO="${2:-}"; shift 2;;
    --pasta)   PASTA="${2:-}"; shift 2;;
    --versao)  VERSAO="${2:-}"; shift 2;;
    --nome)    NOME_APP="${2:-}"; shift 2;;
    --cadastro-aberto) CADASTRO_PUBLICO_VALOR="true"; shift;;
    --manter-senha-do-dono) MANTER_SENHA=1; shift;;
    --ensaio)  ENSAIO=1; shift;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0;;
    *) die "Opção desconhecida: $1 (veja --help)";;
  esac
done

# ── Entrada que vai para dentro de um comando remoto: só caracteres inofensivos ──
case "$HOST" in ''|*[!A-Za-z0-9.:_-]*) die "Informe --host com o IP (ou nome) da VPS.";; esac
case "$PASTA" in ''|*[!A-Za-z0-9_./-]*) die "--pasta tem caractere que não pode ir num comando remoto.";; esac
case "$VERSAO" in ''|v[0-9]*.[0-9]*.[0-9]*) ;; *) die "--versao precisa ter a forma vX.Y.Z (ex.: v1.18.0).";; esac
case "$VERSAO" in *[!A-Za-z0-9.+-]*) die "--versao com caractere inválido.";; esac
case "$DOMINIO" in
  '')      die "Informe --dominio (ex.: crm.suaempresa.com.br).";;
  http*|*/*|*[!A-Za-z0-9.-]*) die "--dominio é só o nome, sem https:// nem barra (ex.: crm.suaempresa.com.br).";;
  *.*)     ;;
  *)       die "--dominio não parece um domínio (falta o ponto).";;
esac
[ -n "$CHAVE" ] || die "Informe --chave com o caminho da sua chave SSH privada."
[ "$ENSAIO" = 1 ] || [ -r "$CHAVE" ] || die "Não consigo ler a chave SSH: $CHAVE"

# Antes de pedir uma só chave: a versão pedida existe INTEIRA? O `install.sh` cai calado no canal
# `stable` (a versão ANTERIOR) quando as três imagens da versão ainda não estão publicadas — e uma
# versão anterior pode nem conhecer o `CADASTRO_PUBLICO`, subindo com o cadastro ABERTO sem aviso.
if [ -n "$VERSAO" ] && [ "$ENSAIO" = 0 ]; then
  step "Conferindo se a $VERSAO está publicada"
  trio_publicado "${VERSAO#v}" \
    || die "A $VERSAO ainda não tem as três imagens publicadas (app, worker e scheduler). Espere a publicação terminar e rode de novo."
  c_grn "✓ as três imagens da $VERSAO existem"
fi

SSH=(ssh -i "$CHAVE" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new
     -o ConnectTimeout=15 -o ServerAliveInterval=20 "root@$HOST")

# ── Leitura de campos ────────────────────────────────────────────────────────
# Lê da entrada padrão: no terminal pede sem eco (-s); num teste, vem do pipe.
if [ -t 0 ]; then LER_S=(-s); else LER_S=(); fi
declare -A V=()

# O MESMO pedaço colado várias vezes seguidas. Campo sem eco não dá sinal nenhum de que a
# colagem "pegou", e quem cola de novo acaba mandando a chave 4x (aconteceu: uma chave de 46
# caracteres chegou com 184, e o Supabase respondeu 401 como se ela estivesse errada).
# Acha o MENOR pedaço que, repetido, reproduz o valor; só olha pedaços de 8+ caracteres.
valor_repetido() {
  local v="$1" n=${#1} k p parte rep i
  for k in 8 7 6 5 4 3 2; do
    [ $((n % k)) -eq 0 ] || continue
    p=$((n / k)); [ "$p" -ge 8 ] || continue
    parte="${v:0:p}"; rep=""
    for ((i = 0; i < k; i++)); do rep="$rep$parte"; done
    if [ "$rep" = "$v" ]; then
      echo "Isto parece o MESMO valor colado $k vezes seguidas ($n caracteres; o certo teria $p). O campo não mostra o que você cola: cole UMA vez só e tecle Enter."
      return 0
    fi
  done
  return 0
}

ler() { # ler <VAR> <pergunta> [secreto|aberto] [opcional]
  local var="$1" pergunta="$2" modo="${3:-aberto}" opcional="${4:-}" val=""
  while true; do
    if [ "$modo" = secreto ]; then
      IFS= read -r ${LER_S[@]+"${LER_S[@]}"} -p "$pergunta: " val || val=""
      [ -t 0 ] && printf '\n'
    else
      IFS= read -r -p "$pergunta: " val || val=""
    fi
    val="${val%$'\r'}"
    case "$val" in *$'\n'*) c_red "  Valor com quebra de linha não serve."; continue;; esac
    if [ -z "$val" ]; then
      [ -n "$opcional" ] && { V[$var]=""; return 0; }
      if [ ! -t 0 ]; then die "Faltou o valor de: $pergunta"; fi
      c_ylw "  Esse campo é obrigatório."; continue
    fi
    if [ "$modo" = secreto ]; then
      local repetido; repetido="$(valor_repetido "$val")"
      if [ -n "$repetido" ]; then
        c_red "  $repetido"
        [ -t 0 ] || die "Valor colado repetido em: $pergunta"
        continue
      fi
      # Só o TAMANHO, nunca o valor: é o único sinal de que a colagem pegou.
      c_dim "  ✓ recebido: ${#val} caracteres"
    fi
    V[$var]="$val"; return 0
  done
}
# Valida e repete a pergunta (no terminal) ou morre (no pipe).
ler_validado() { # ler_validado <VAR> <pergunta> <validador> [secreto|aberto] [opcional]
  local var="$1" pergunta="$2" validador="$3" modo="${4:-aberto}" opcional="${5:-}" msg
  while true; do
    ler "$var" "$pergunta" "$modo" "$opcional"
    [ -z "${V[$var]}" ] && return 0
    if msg="$("$validador" "${V[$var]}" 2>&1)"; then return 0; fi
    c_red "  $msg"
    [ -t 0 ] || die "Valor inválido para: $pergunta"
  done
}

v_nao_vazio_sem_espaco() { case "$1" in *[[:space:]]*) echo "Não pode ter espaço — copiou inteiro e sem nada ao redor?"; return 1;; esac; }
v_url_supabase() {
  case "$1" in https://*.*) ;; *) echo "Cole a Project URL do Supabase, começando com https://"; return 1;; esac
  v_nao_vazio_sem_espaco "$1"
}
v_chave_supabase() {
  v_nao_vazio_sem_espaco "$1" || return 1
  [ "${#1}" -ge 20 ] || { echo "Chave curta demais (${#1} caracteres) — copiou inteira?"; return 1; }
}
v_db_url() {
  case "$1" in postgres://*|postgresql://*) ;; *) echo "A connection string começa com postgres:// (Settings › Database › Session pooler)"; return 1;; esac
  # Os dois tropeços de sempre, pegos aqui para não custar uma instalação inteira:
  case "$1" in
    *"[YOUR-PASSWORD]"*|*"[SUA-SENHA]"*|*"[your-password]"*)
      echo "A string veio com [YOUR-PASSWORD] no meio — troque pela senha do banco (a que você definiu ao criar o projeto)."; return 1;;
    *db.*.supabase.co*)
      echo "Essa é a 'Direct connection'. Use a do Session pooler (o host termina em .pooler.supabase.com)."; return 1;;
  esac
  v_nao_vazio_sem_espaco "$1"
}
v_email() { case "$1" in *@*.*) ;; *) echo "E-mail inválido — precisa de @ e domínio."; return 1;; esac; v_nao_vazio_sem_espaco "$1"; }
v_senha() { [ "${#1}" -ge 12 ] || { echo "Use pelo menos 12 caracteres: é a senha do administrador da PLATAFORMA (vê todos os clientes)."; return 1; }; }
v_prefixo_ia() { case "$IA_PREFIXO" in '') return 0;; esac; case "$1" in "$IA_PREFIXO"*) ;; *) echo "Essa chave deveria começar com '$IA_PREFIXO'."; return 1;; esac; v_nao_vazio_sem_espaco "$1"; }
v_openai() { case "$1" in sk-*) ;; *) echo "A chave da OpenAI começa com 'sk-'."; return 1;; esac; v_nao_vazio_sem_espaco "$1"; }

# ── Dados do Supabase e da IA ────────────────────────────────────────────────
printf '\n'; paint 1 "▶ Elev CRM — instalação em $DOMINIO ($HOST)"
[ "$ENSAIO" = 1 ] && c_ylw "  ENSAIO: nada será enviado nem executado na VPS."
printf '%s\n' "  Cole cada valor e tecle Enter. Senhas e chaves não aparecem na tela." ""

ler_validado SUPABASE_URL  "Supabase › Project URL"                         v_url_supabase
ler_validado SUPABASE_ANON "Supabase › anon / publishable key"              v_chave_supabase secreto
ler_validado SUPABASE_SVC  "Supabase › service_role / secret key"           v_chave_supabase secreto
ler_validado SUPABASE_DB   "Supabase › connection string (Session pooler)"  v_db_url         secreto

printf '\n%s\n' "  Provedor da IA da plataforma (a chave do CLIENTE é cadastrada por ele depois):"
printf '%s\n'   "    1) OpenRouter   2) Anthropic   3) OpenAI"
ler IA_ESCOLHA "  Escolha 1, 2 ou 3"
case "${V[IA_ESCOLHA]}" in
  1) IA_VAR=OPENROUTER_API_KEY; IA_PREFIXO="sk-or-";;
  2) IA_VAR=ANTHROPIC_API_KEY;  IA_PREFIXO="sk-ant-";;
  3) IA_VAR=OPENAI_API_KEY;     IA_PREFIXO="sk-";;
  *) die "Escolha 1, 2 ou 3.";;
esac
ler_validado IA_CHAVE "  Chave da IA ($IA_VAR) — use uma COM LIMITE DE GASTO" v_prefixo_ia secreto
if [ "$IA_VAR" != OPENAI_API_KEY ]; then
  ler_validado OPENAI_EXTRA "  Chave da OpenAI para ouvir áudios (Enter pula)" v_openai secreto opcional
else
  V[OPENAI_EXTRA]=""
fi

# ── O administrador da plataforma ────────────────────────────────────────────
printf '\n%s\n' "  O primeiro administrador — vê TODOS os clientes. Use um e-mail seu, que você lê."
ler_validado OWNER_EMAIL "  E-mail do administrador" v_email
while true; do
  ler_validado OWNER_SENHA "  Senha do administrador (12+ caracteres)" v_senha secreto
  ler OWNER_SENHA2 "  Repita a senha" secreto
  [ "${V[OWNER_SENHA]}" = "${V[OWNER_SENHA2]}" ] && break
  c_red "  As senhas não conferem."
  [ -t 0 ] || die "As senhas não conferem."
done
ler_validado ACME_EMAIL "  E-mail para avisos do certificado HTTPS (Enter = o mesmo)" v_email aberto opcional
[ -n "${V[ACME_EMAIL]}" ] || V[ACME_EMAIL]="${V[OWNER_EMAIL]}"
ler_validado RESEND_KEY  "  Chave da Resend, para enviar convites por e-mail (Enter pula)" v_nao_vazio_sem_espaco secreto opcional
if [ -n "${V[RESEND_KEY]}" ]; then
  ler_validado RESEND_FROM "  Remetente dos e-mails (de um domínio verificado na Resend)" v_email
else
  V[RESEND_FROM]=""
fi

# ── Monta o .env (aspas duplas, \ " $ ` escapados — igual ao install.sh) ─────
envq() { printf '%s="%s"\n' "$1" "$(printf '%s' "${2-}" | sed 's/[\\"$`]/\\&/g')"; }
URL_SUPABASE="${V[SUPABASE_URL]%/}"

ENV_TXT="$(
  envq DOMAIN "$DOMINIO"
  envq ACME_EMAIL "${V[ACME_EMAIL]}"
  envq NEXT_PUBLIC_SUPABASE_URL "$URL_SUPABASE"
  envq NEXT_PUBLIC_SUPABASE_ANON_KEY "${V[SUPABASE_ANON]}"
  envq SUPABASE_SERVICE_ROLE_KEY "${V[SUPABASE_SVC]}"
  envq SUPABASE_DB_URL "${V[SUPABASE_DB]}"
  envq "$IA_VAR" "${V[IA_CHAVE]}"
  [ -n "${V[OPENAI_EXTRA]}" ] && envq OPENAI_API_KEY "${V[OPENAI_EXTRA]}"
  envq OWNER_EMAIL "${V[OWNER_EMAIL]}"
  envq OWNER_PASSWORD "${V[OWNER_SENHA]}"
  envq APP_NAME "$NOME_APP"
  envq CADASTRO_PUBLICO "$CADASTRO_PUBLICO_VALOR"
  # Telemetria: nada sai desta instalação sem decisão explícita.
  envq SENTRY_DSN "off"
  [ -n "${V[RESEND_KEY]}" ] && envq RESEND_API_KEY "${V[RESEND_KEY]}"
  [ -n "${V[RESEND_FROM]}" ] && envq RESEND_FROM_EMAIL "${V[RESEND_FROM]}"
  true
)"

# O que pode ser mostrado em claro; o resto aparece só como "N caracteres".
mascarado() {
  local linha nome val
  while IFS= read -r linha; do
    nome="${linha%%=*}"; val="${linha#*=}"; val="${val#\"}"; val="${val%\"}"
    case "$nome" in
      DOMAIN|ACME_EMAIL|NEXT_PUBLIC_SUPABASE_URL|OWNER_EMAIL|APP_NAME|CADASTRO_PUBLICO|SENTRY_DSN|RESEND_FROM_EMAIL)
        printf '    %-30s %s\n' "$nome" "$val";;
      *) printf '    %-30s ******** (%d caracteres)\n' "$nome" "${#val}";;
    esac
  done <<< "$ENV_TXT"
}

# ── O nome aponta para a VPS? ────────────────────────────────────────────────
step "Conferindo o endereço $DOMINIO"
IPS="$(getent ahostsv4 "$DOMINIO" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
if [ -z "${IPS// }" ]; then
  die "O nome $DOMINIO ainda não aponta para lugar nenhum. Crie um registro A: $DOMINIO → $HOST, espere alguns minutos e rode de novo."
fi
case " $IPS " in
  *" $HOST "*) c_grn "✓ $DOMINIO → $HOST";;
  *) die "$DOMINIO aponta para ${IPS% }, e não para $HOST. Sem isso o certificado HTTPS não é emitido. Corrija o registro A e rode de novo.";;
esac

if [ "$ENSAIO" = 1 ]; then
  step "ENSAIO — o que seria enviado para $PASTA/.env"
  mascarado
  printf '\n  Depois: %s\n' "${VERSAO:+levar o kit da VPS para $VERSAO; }install.sh --yes na VPS (em segundo plano, com log)"
  printf '  Depois: %s\n' "$([ "$MANTER_SENHA" = 1 ] && echo 'manter OWNER_PASSWORD no .env' || echo 'apagar OWNER_PASSWORD do .env')"
  c_grn "✓ ensaio concluído — nada foi enviado."
  exit 0
fi

# ── A VPS está como esperado? ────────────────────────────────────────────────
step "Conferindo a VPS"
"${SSH[@]}" "true" 2>/dev/null || die "Não consegui entrar na VPS ($HOST) com a chave $CHAVE."
c_grn "✓ SSH entra pela chave"
"${SSH[@]}" "test -f '$PASTA/docker-compose.prod.yml'" || die "O kit não está em $PASTA na VPS."
if "${SSH[@]}" "test -e '$PASTA/.env'"; then
  die "Já existe $PASTA/.env na VPS. Não sobrescrevo: ele guarda as chaves que cifram dados do banco.
  Para reinstalar de verdade, mova-o de propósito:  ssh root@$HOST 'mv $PASTA/.env $PASTA/.env.antigo'"
fi
c_grn "✓ $PASTA/.env ainda não existe"

if [ -n "$VERSAO" ]; then
  step "Levando o kit da VPS para $VERSAO"
  "${SSH[@]}" "cd '$PASTA' && git fetch --tags --quiet && git checkout --quiet '$VERSAO' && git describe --tags --always" \
    || die "Não consegui mudar o kit para $VERSAO (a tag existe?)."
fi

# ── Envia o .env pela entrada padrão (nunca por argumento) ───────────────────
step "Enviando a configuração"
printf '%s\n' "$ENV_TXT" | "${SSH[@]}" "umask 077; cat > '$PASTA/.env.novo' && mv '$PASTA/.env.novo' '$PASTA/.env' && chmod 600 '$PASTA/.env'" \
  || die "Não consegui gravar o .env na VPS."
EMAIL_ADMIN="${V[OWNER_EMAIL]}"
unset ENV_TXT V
c_grn "✓ .env gravado (permissão 600)"

# ── Roda o install.sh na VPS, em segundo plano, com log que sobrevive à queda do SSH ──
step "Instalando (baixa as imagens, sobe os serviços — leva vários minutos)"
LOG="/var/log/elevcrm-install.log"
"${SSH[@]}" "LOG='$LOG' PASTA='$PASTA' bash -s" <<'REMOTO'
set -e
: > "$LOG"; chmod 600 "$LOG"
cd "$PASTA"
setsid nohup bash -c 'NO_COLOR=1 bash hostgator-setup-kit/install.sh --yes; echo "__RC=$?"' >> "$LOG" 2>&1 < /dev/null &
REMOTO

OFFSET=0; RC=""; FALHAS_SSH=0; INICIO="$(date +%s)"
while [ -z "$RC" ]; do
  sleep 8
  if NOVO="$("${SSH[@]}" "tail -n +$((OFFSET + 1)) '$LOG'" 2>/dev/null)"; then
    FALHAS_SSH=0
    if [ -n "$NOVO" ]; then
      printf '%s\n' "$NOVO" | grep -v '^__RC=' || true
      OFFSET=$((OFFSET + $(printf '%s\n' "$NOVO" | wc -l)))
      RC="$(printf '%s\n' "$NOVO" | sed -n 's/^__RC=//p' | tail -1)"
    fi
  else
    FALHAS_SSH=$((FALHAS_SSH + 1))
    [ "$FALHAS_SSH" -ge 30 ] && die "Perdi o contato com a VPS. A instalação segue lá; veja: ssh root@$HOST tail -f $LOG"
  fi
  [ $(( $(date +%s) - INICIO )) -gt 2400 ] && die "A instalação passou de 40 minutos. Veja: ssh root@$HOST tail -f $LOG"
done
[ "$RC" = 0 ] || die "O install.sh terminou com erro ($RC). O log completo está em $LOG na VPS."
c_grn "✓ install.sh terminou"

# Subiu a versão que se pediu? (O instalador pode ter caído em outra, e dito "deu certo".)
if [ -n "$VERSAO" ]; then
  IMAGEM_GRAVADA="$("${SSH[@]}" "sed -n 's/^APP_IMAGE=\"\\(.*\\)\"\$/\\1/p' '$PASTA/.env'" 2>/dev/null || true)"
  case "$IMAGEM_GRAVADA" in
    *":${VERSAO#v}") c_grn "✓ o app instalado é a ${VERSAO#v} ($IMAGEM_GRAVADA)";;
    *) die "Pedi a $VERSAO, mas o .env da VPS ficou com ${IMAGEM_GRAVADA:-<nada>}. Não siga: o cadastro público pode estar ABERTO. Veja $LOG na VPS.";;
  esac
fi

# ── A senha do administrador não precisa ficar em texto no disco ─────────────
if [ "$MANTER_SENHA" = 0 ]; then
  "${SSH[@]}" "sed -i '/^OWNER_PASSWORD=/d' '$PASTA/.env'" && c_grn "✓ OWNER_PASSWORD apagada do .env da VPS (você a sabe; reinstalar vai pedir de novo)"
fi

# ── Está no ar? ──────────────────────────────────────────────────────────────
step "Conferindo $DOMINIO por HTTPS"
OK=0
for _ in $(seq 1 12); do
  CODIGO="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMINIO/login" || true)"
  [ "$CODIGO" = 200 ] && { OK=1; break; }
  sleep 10
done
[ "$OK" = 1 ] && c_grn "✓ https://$DOMINIO/login respondeu 200" || c_ylw "⚠ https://$DOMINIO/login ainda não respondeu 200 (último: ${CODIGO:-?}). O certificado pode levar alguns minutos."

cat <<FIM

$(paint 1 "Falta UMA coisa, no painel do Supabase (Authentication › URL Configuration):")
  Site URL ......... https://$DOMINIO
  Redirect URLs .... https://$DOMINIO/**
Sem isso os links de e-mail (confirmar conta, aceitar convite) apontam para o lugar errado.

Acesso:  https://$DOMINIO     (administrador: $EMAIL_ADMIN)
FIM
