#!/usr/bin/env bash
#
# A DEMONSTRAÇÃO DA INTEGRAÇÃO, em um comando.
#
#   pnpm exec bash scripts/demo-despachocerto.sh subir     # sobe o Despacho Certo de demonstração
#   pnpm exec bash scripts/demo-despachocerto.sh os <placa>  # abre uma OS e marca a conversa
#   pnpm exec bash scripts/demo-despachocerto.sh estado    # o que o stub tem guardado
#
# O "Despacho Certo de demonstração" é um servidor HTTP de verdade
# (`scripts/stub-despachocerto.ts`) que implementa o contrato da integração. O
# Elev CRM fala com ele exatamente como falará com o sistema real: Bearer,
# JSON, webhook assinado. Quando a API real existir, troque o endereço em
# Configurações → Canais → Despacho Certo e mais nada muda.
#
# Roteiro de demonstração:
#   1. `subir` (deixe rodando numa aba)
#   2. no CRM, Configurações → Canais → Despacho Certo: endereço
#      http://localhost:4010 e a chave `chave-demo`; salve e copie o segredo
#   3. rode `subir` de novo com DEMO_SEGREDO=<o segredo copiado>
#   4. abra uma conversa → "Cadastrar" → preencha → o cliente nasce no stub
#   5. `os ABC1D23` → as tags "OS ####" e "ABC1D23" aparecem na conversa
set -u
cd "$(dirname "$0")/.."

PORTA="${DEMO_PORTA:-4010}"
CHAVE="${DEMO_CHAVE:-chave-demo}"
CRM="${DEMO_CRM:-http://localhost:3100}"

token_do_webhook() {
  docker exec supabase_db_elev-crm psql -U postgres -d postgres -tA \
    -c "select webhook_path_token from tenant_integrations where provider='despachocerto' limit 1" 2>/dev/null | tr -d ' \n'
}

case "${1:-}" in
  subir)
    TOKEN=$(token_do_webhook)
    if [ -z "$TOKEN" ]; then
      echo "A integração ainda não foi ligada no CRM."
      echo "Vá em Configurações → Canais → Despacho Certo, use:"
      echo "  endereço: http://localhost:$PORTA"
      echo "  chave:    $CHAVE"
      echo "Salve, copie o segredo, e rode de novo com DEMO_SEGREDO=<segredo>."
      exit 1
    fi
    echo "webhook do CRM: $CRM/api/v1/webhooks/despachocerto/$TOKEN"
    # SEM SEGREDO o stub assina com string vazia, e o CRM responde 401 — que é
    # o comportamento certo dele e o mais confuso possível aqui, porque o
    # cadastro funciona e só a OS não chega. Dizer isto ANTES de subir custa
    # uma linha; descobrir no meio da demonstração custa a demonstração.
    if [ -z "${DEMO_SEGREDO:-}" ]; then
      echo
      echo "AVISO: DEMO_SEGREDO vazio — o cadastro vai funcionar, mas a OS será"
      echo "       recusada com 401. Em Configurações → Canais → Despacho Certo,"
      echo "       clique em Salvar para gerar um segredo, copie, e suba assim:"
      echo "         DEMO_SEGREDO=<segredo> bash scripts/demo-despachocerto.sh subir"
      echo
    fi
    STUB_DC_PORT="$PORTA" \
    STUB_DC_KEY="$CHAVE" \
    STUB_DC_WEBHOOK="$CRM/api/v1/webhooks/despachocerto/$TOKEN" \
    STUB_DC_SECRET="${DEMO_SEGREDO:-}" \
      exec pnpm exec tsx scripts/stub-despachocerto.ts
    ;;

  os)
    PLACA="${2:-ABC1D23}"
    CLIENTE=$(docker exec supabase_db_elev-crm psql -U postgres -d postgres -tA \
      -c "select external_id from integration_contact_links where provider='despachocerto' order by updated_at desc limit 1" 2>/dev/null | tr -d ' \n')
    if [ -z "$CLIENTE" ]; then
      echo "Nenhum contato foi cadastrado ainda — clique 'Cadastrar' numa conversa primeiro."
      exit 1
    fi
    echo "abrindo OS para o cliente $CLIENTE (placa $PLACA)…"
    curl -s --max-time 20 -X POST -H 'Content-Type: application/json' \
      -d "{\"client_id\":\"$CLIENTE\",\"plate\":\"$PLACA\"}" \
      "http://127.0.0.1:$PORTA/_demo/work-order"
    echo
    echo "--- tags agora:"
    docker exec supabase_db_elev-crm psql -U postgres -d postgres -tA -F ' | ' -c \
      "select coalesce(c.display_name, c.name, c.phone_number), array_to_string(c.tags, ', ')
         from contacts c
         join integration_contact_links l on l.contact_id = c.id
        where l.provider='despachocerto'"
    ;;

  estado)
    curl -s --max-time 5 "http://127.0.0.1:$PORTA/_demo/state"; echo
    ;;

  *)
    sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
