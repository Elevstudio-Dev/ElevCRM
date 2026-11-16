---
impacto: capacidade_nova
secao: adicionado
titulo: "Backup local diário ligado por padrão e falha de cron deixa rastro (e o monitor avisa)"
---

O `install.sh` e o `update.sh` agora ligam, no cron do servidor, o backup local diário do banco e das sessões do WhatsApp (03:02 UTC, 14 dias no disco da VPS, saída em `.backup.log`). Antes ele só existia se alguém pusesse a linha no crontab à mão — e numa instalação real o único backup eram os das atualizações, com mais de 100 horas. Os crons do scheduler deixaram de descartar a falha: cada falha escreve `scheduler: cron <rota> falhou (curl saiu com N)` no log do contêiner, sem o segredo. O monitor do servidor passou a avisar quando o último backup local tem mais de 30 horas e quando uma mesma rota de cron falha três vezes ou mais em 10 minutos. O backup **fora** da VPS continua exigindo o destino e a chave de cifra no `.env` (ver `docs/runbooks/operacao-24h.md`).
