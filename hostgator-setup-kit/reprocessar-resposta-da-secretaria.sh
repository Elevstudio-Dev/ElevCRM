#!/usr/bin/env bash
# Reprocessar a resposta ("sim") de uma secretária que NÃO foi aplicada na agenda.
#
# Quando usar: a Central mostrou "A agenda que a secretária confirmou não foi aplicada" (ou a secretária disse "sim"
# e a agenda não mudou), e a versão com o conserto JÁ está instalada. Passo a passo em
# docs/runbooks/agenda-da-secretaria.md.
#
#   bash hostgator-setup-kit/reprocessar-resposta-da-secretaria.sh --organizacao <uuid> --job <uuid>
#   bash hostgator-setup-kit/reprocessar-resposta-da-secretaria.sh --organizacao <uuid> --mensagem <uuid>
#   bash hostgator-setup-kit/reprocessar-resposta-da-secretaria.sh --organizacao <uuid> --relato <uuid>
#   ... e, depois de conferir a prévia, o MESMO comando com --aplicar
#
# Sem --aplicar só MOSTRA (relato, a mensagem que o turno vai ler, a validade medida até a resposta dela e a prévia
# do que muda na agenda). Com --aplicar enfileira UM turno novo da secretaria para aquela mensagem — nada mais: quem
# aplica a agenda é o worker, pelo caminho de sempre. Recusa (e não escreve nada) se o relato não estiver esperando o
# "sim", se houver resumo mais novo, se a resposta veio depois de 12 h, ou se já houver turno dela na fila.
AQUI="$(cd "$(dirname "$0")" && pwd)"
SQL="$AQUI/reprocessar-resposta-da-secretaria.sql"

uso() {
  printf '%s\n' "Uso: reprocessar-resposta-da-secretaria.sh --organizacao <uuid> (--job <uuid> | --mensagem <uuid> | --relato <uuid>) [--aplicar [--sim]]" >&2
  exit 1
}

UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
ORG="" MSG="" RELATO="" JOB="" APLICAR=0 SEM_PERGUNTA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --organizacao) ORG="${2:-}"; shift 2 || uso ;;
    --mensagem)    MSG="${2:-}"; shift 2 || uso ;;
    --relato)      RELATO="${2:-}"; shift 2 || uso ;;
    --job)         JOB="${2:-}"; shift 2 || uso ;;
    --aplicar)     APLICAR=1; shift ;;
    --sim)         SEM_PERGUNTA=1; shift ;;
    *) uso ;;
  esac
done

# Validar ANTES de tocar em qualquer coisa: o valor vai para o psql como variável (:'org'), nunca colado no SQL, mas
# um id torto aqui é quase sempre um id copiado errado — melhor parar com a frase certa.
[[ "$ORG" =~ $UUID_RE ]] || { printf '%s\n' "✖ --organizacao precisa ser um uuid." >&2; uso; }
[ -n "$MSG$RELATO$JOB" ] || { printf '%s\n' "✖ Informe --job, --mensagem ou --relato." >&2; uso; }
for v in "$MSG" "$RELATO" "$JOB"; do
  [ -z "$v" ] || [[ "$v" =~ $UUID_RE ]] || { printf '%s\n' "✖ id inválido: $v" >&2; uso; }
done
[ -f "$SQL" ] || { printf '%s\n' "✖ Não achei $SQL." >&2; exit 1; }

source "$AQUI/_common.sh"
enter_project

if [ "$APLICAR" = 1 ] && [ "$SEM_PERGUNTA" != 1 ]; then
  c_ylw "Isto enfileira UM turno novo da secretaria para essa resposta (a agenda muda quando o worker processar)."
  c_ylw "Rode antes SEM --aplicar e confira a prévia."
  read -r -p "Enfileirar? (s/N) " a; resposta_sim "$a" || die "Cancelado. Nada foi alterado."
fi

step "$([ "$APLICAR" = 1 ] && echo 'Enfileirando' || echo 'Prévia (nada é alterado)')"
if psql_run -q -v org="$ORG" -v msg="$MSG" -v relato="$RELATO" -v job="$JOB" -v aplicar="$APLICAR" < "$SQL"; then
  if [ "$APLICAR" = 1 ]; then c_grn "✓ Feito. Confira a conversa dela e a agenda em alguns segundos."; fi
else
  die "Nada foi alterado (veja o motivo acima, na linha 'Recusado: …')."
fi
