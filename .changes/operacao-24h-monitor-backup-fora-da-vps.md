---
impacto: capacidade_nova
secao: adicionado
titulo: Operação 24 horas — o servidor avisa quando algo está errado, e o backup (do banco e dos arquivos dos pacientes) sai da VPS
---

Cinco peças novas no kit de instalação, todas opcionais — nada muda para quem
não as liga.

**monitor.sh.** Roda a cada 5 minutos e confere o Docker, cada serviço, a saúde
do app, disco, memória, certificado HTTPS, reinício pendente e a idade do
último backup. Avisa um monitor externo (`HEARTBEAT_URL` no `.env`, só
`https://`): tudo bem, ele pinga; problema, ele pinga `<URL>/fail` com o
motivo; **silêncio**, o próprio monitor externo alerta — que é a única forma de
perceber uma VPS inteira fora do ar.

**backup-fora.sh.** Leva o banco, o `.env` (as chaves que decifram o que o
banco guarda cifrado) e as sessões de WhatsApp para um armazenamento
**fora do servidor**, cifrado com `age`: nada em texto aberto, nem em disco
temporário.
Só a chave pública fica na VPS. O `--teste` confere o destino e avisa se a
chave de envio consegue apagar o que enviou. Liga com `BACKUP_FORA_DESTINO` e
`BACKUP_AGE_RECIPIENT` no `.env`.

**backup-midia.sh.** Leva as **fotos, áudios e documentos dos pacientes** (o
Storage do Supabase) para fora, cifrados (conteúdo e nomes), de forma
incremental. O backup do banco não os inclui: o Supabase restaura a lista dos
arquivos, não os arquivos. É `copy`, nunca `sync` — o Storage não tem
versionamento, então o que foi apagado na origem continua no backup. Liga com
`BACKUP_MIDIA_ORIGEM`, `BACKUP_MIDIA_DESTINO` e `BACKUP_MIDIA_SENHA`.

**testar-restauracao.sh.** Prova que o backup restaura: baixa o mais recente,
confere o hash de cada arquivo, decifra e carrega num Postgres descartável, e
compara o número de tabelas com o banco vivo. Também abre a mídia com a senha e
baixa uma amostra. Termina com **BACKUP PROVADO** ou com o motivo de não ter
provado. Rode todo mês.

**preparar-host.sh.** Prepara um servidor novo: firewall (liberando antes a
porta do SSH em que você está conectado), bloqueio de tentativas de invasão,
atualizações de segurança sem reinício automático, swap e relógio. O
`--dry-run` mostra o plano sem mudar nada.

O `install.sh` e o `update.sh` ligam os crons do monitor e dos backups quando o
`.env` tem o que eles precisam. O passo a passo, a rotina e o que ainda **não**
está coberto (a volta dos arquivos para dentro do Storage do Supabase, o tempo
de reconstrução de uma VPS) estão em `docs/runbooks/operacao-24h.md`.
