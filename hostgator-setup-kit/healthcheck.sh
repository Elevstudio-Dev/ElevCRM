#!/usr/bin/env bash
# Diagnóstico rápido: estado dos containers + saúde do app (Supabase/Redis/WAHA).
source "$(dirname "$0")/_common.sh"
enter_project

step "Containers"
dc ps

step "Saúde interna do app (/api/v1/health)"
# Roda de dentro da rede do compose (a rota não é exposta publicamente sem TLS).
#
# Pelo status GERAL (healthy|degraded|unhealthy), e não por grep de `"status":"ok"`
# no JSON cru: `ok` é o vocabulário dos checks individuais, então o grep casava com
# o do Redis e dava "✓ app saudável" para um app com o BANCO fora. É o mesmo
# critério do install.sh e do update.sh — ver `app_health_probe` em _common.sh.
saida="$(app_health_probe)"
status_geral="$(printf '%s\n' "$saida" | head -1 | tr -d '\r')"
corpo="$(printf '%s\n' "$saida" | tail -n +2)"
if [ -n "$saida" ]; then
  printf '%s\n' "$corpo"
  case "$status_geral" in
    healthy)   c_grn "✓ app saudável" ;;
    degraded)  c_ylw "⚠ app no ar, com um serviço opcional degradado (veja o JSON acima)." ;;
    *)         c_red "✖ app com serviço FORA ($status_geral) — veja o JSON acima." ;;
  esac
else
  c_ylw "⚠ app não respondeu. Logs: docker compose $(dc_files) logs --tail=50 app"
fi

step "Monitor do servidor e backup fora da VPS"
if crontab -l 2>/dev/null | grep -q 'hostgator-setup-kit/monitor.sh'; then
  c_grn "✓ monitor ativo no cron (a cada 5 minutos)"
  [ -s "$PROJECT_DIR/.monitor.log" ] && c_dim "  última rodada: $(tail -1 "$PROJECT_DIR/.monitor.log")"
else
  c_ylw "⚠ monitor desligado — sem HEARTBEAT_URL ninguém é avisado se o servidor cair (docs/runbooks/operacao-24h.md)."
fi
if backup_fora_configurado; then
  if [ -f "$PROJECT_DIR/.backup-fora.ok" ]; then
    c_grn "✓ backup fora da VPS configurado; último ok em $(date -u -d "@$(head -1 "$PROJECT_DIR/.backup-fora.ok" | tr -cd '0-9')" +%FT%TZ 2>/dev/null || echo '?')"
  else
    c_ylw "⚠ backup fora da VPS configurado, mas ainda não rodou — teste com: bash hostgator-setup-kit/backup-fora.sh --teste"
  fi
else
  c_ylw "⚠ sem backup fora da VPS — se este servidor morrer, o backup morre junto (docs/runbooks/operacao-24h.md)."
fi
if backup_midia_configurado; then
  if [ -f "$PROJECT_DIR/.backup-midia.ok" ]; then
    c_grn "✓ backup dos arquivos de mídia configurado; último ok em $(date -u -d "@$(head -1 "$PROJECT_DIR/.backup-midia.ok" | tr -cd '0-9')" +%FT%TZ 2>/dev/null || echo '?')"
  else
    c_ylw "⚠ backup dos arquivos de mídia configurado, mas ainda não rodou — teste com: bash hostgator-setup-kit/backup-midia.sh --teste"
  fi
else
  c_ylw "⚠ sem backup dos arquivos de mídia — as fotos e áudios dos pacientes não voltam se forem perdidos (docs/runbooks/operacao-24h.md)."
fi

step "Atualização pela tela (agente do host)"
# Achado numa VPS real: o cron do agente é instalado no TOPO do update.sh, de
# propósito (para sobreviver a uma saída antecipada) — e isso cria uma janela em
# que o agente existe e o schema do banco ainda não. Ele então bate 500 a cada 5
# minutos, com o erro indo só para o .update-agent.log e o `>/dev/null` do cron.
# Para o dono, o sintoma é "o botão nunca apareceu": nenhuma pista, nenhum alarme.
# Este bloco é a pista.
if crontab -l 2>/dev/null | grep -q 'hostgator-setup-kit/agent.sh'; then
  c_grn "✓ agente instalado no cron (a cada 5 minutos)"
  log="$PROJECT_DIR/.update-agent.log"
  # Recência pela MTIME do arquivo, não parseando a data de dentro: `date -d` é
  # sintaxe GNU e falha calado no BSD/macOS, devolvendo "sem falhas" para um
  # agente que está falhando agora. `find -mmin` é portátil.
  if [ -s "$log" ] && [ -n "$(find "$log" -mmin -120 2>/dev/null)" ]; then
    c_ylw "⚠ o agente falhou recentemente ao falar com o app:"
    c_ylw "  $(tail -2 "$log" | head -1)"
    c_ylw "  Se o botão de atualizar não aparece na tela, é por isto."
    c_ylw "  Quase sempre resolve rodando: bash hostgator-setup-kit/update.sh"
  else
    c_grn "✓ sem falhas recentes do agente"
  fi
else
  c_ylw "⚠ o agente NÃO está no cron — o botão de atualizar não vai aparecer na tela."
  c_ylw "  Ative rodando: bash hostgator-setup-kit/update.sh"
fi
