# Operação 24 horas — o Elev CRM no ar para vários clientes

Para quem opera o Elev CRM como serviço: **uma VPS, uma instalação, um banco, vários
clientes** (cada cliente é uma organização). Este documento diz o que fazer para o sistema
ficar no ar, como saber quando não está, e como voltar.

> **O que isto NÃO promete.** "24 horas sem problema" é uma meta, não uma garantia: com uma
> VPS só, ela cai de vez em quando (a do provedor, a do banco, a da Meta). O que este
> documento entrega é: **cair menos, você saber em minutos, voltar sem perder dado** — e
> uma lista honesta do que ainda não está coberto (§8). Não prometa percentual de
> disponibilidade a cliente enquanto o monitor não tiver medido alguns meses.

## 1. O que cada peça faz, e o que acontece quando ela cai

| Cai | O cliente sente | Você fica sabendo | Volta sozinho? |
|---|---|---|---|
| Um serviço do CRM (app, worker, scheduler…) | atendimento para por instantes | `monitor.sh` → alerta | **Sim** — `restart: unless-stopped`. Se reinicia em laço, o monitor acusa. |
| A VPS inteira | tudo para | **só o monitor externo percebe** (a VPS não avisa de si mesma): o pinga para de chegar | Não — §7 |
| O banco (Supabase) | tudo para | `monitor.sh` (app `unhealthy`) + monitor externo | Quando o Supabase voltar |
| O app trava mas o contêiner "está de pé" | tela não abre | monitor externo (HTTP) | Não — `docker compose restart app` |
| O disco enche | tudo para, depois de um tempo | `monitor.sh` avisa a 80% e acusa a 90% | Não |
| O certificado HTTPS não renova | navegador recusa o site | `monitor.sh` avisa 21 dias antes | Não |
| A Meta / o WhatsApp | mensagens não chegam | canal aparece com erro na tela; o monitor **não** vê isto | Quando voltar |
| O backup para de chegar | **ninguém sente** — até o desastre | `monitor.sh` acusa depois de 30 h | Não |

A última linha é a mais perigosa: backup que falha em silêncio só aparece na hora de
restaurar. Por isso o monitor trata "backup com mais de 30 h" como **problema**, e não aviso.

## 2. As contas que você precisa ter

| Conta | Para quê | Quem paga |
|---|---|---|
| VPS (Hostinger) | rodar o CRM | a Elev |
| Domínio (subdomínio da Elev) | o endereço público; a Meta exige HTTPS | a Elev |
| **Supabase, plano Pro** | o banco. O grátis [não tem backup e pausa o projeto após 1 semana parado](https://supabase.com/docs/pricing); o Pro guarda backup diário por 7 dias | a Elev |
| Backblaze B2 (ou S3) | a cópia do backup **fora** da VPS | a Elev |
| Monitor com "dead man's switch" (healthchecks.io ou equivalente) | perceber a queda da VPS inteira | a Elev |
| Monitor de site (UptimeRobot, Better Stack…) | perceber que o site não abre | a Elev |
| Meta (Tech Provider) | WhatsApp oficial — ver [`meta-tech-provider.md`](meta-tech-provider.md) | a Elev |
| Chave de IA de cada cliente | o cliente cadastra a dele, em Configurações → IA | o cliente |

## 3. Preparar o servidor (uma vez)

1. **VPS limpa e só do CRM.** Mínimo do kit: 2 vCPU / 4 GB. Para vários clientes, planeje
   mais memória — **não foi medido**: meça com `docker stats` depois de alguns clientes. Ligue
   os **backups/snapshots automáticos do provedor** no painel (isto o script não faz).
2. **DNS**: um registro A do subdomínio para o IP da VPS.
3. **Prepare o sistema operacional** (firewall, bloqueio de tentativas de invasão, atualizações
   de segurança, swap, relógio):

   ```bash
   sudo bash hostgator-setup-kit/preparar-host.sh --dry-run   # veja o plano primeiro
   sudo bash hostgator-setup-kit/preparar-host.sh
   ```

   Ele descobre a porta do seu SSH e a libera **antes** de ligar o firewall. Reinício
   automático fica desligado de propósito; o monitor avisa quando há reinício pendente.
   Opcional, depois de testar a sua chave em outra janela: `--ssh-so-chave`.
4. **Instale** o CRM com o `install.sh` (README do kit). Escolha o Supabase **Pro**, região
   São Paulo.

## 4. Ligar o monitor (sem isto você não sabe se caiu)

1. No healthchecks.io (ou equivalente), crie um check com **período de 5 minutos** e
   tolerância de ~10. Copie a URL de ping.
2. No `.env` da VPS: `HEARTBEAT_URL=https://hc-ping.com/…` — **só `https://`**.
3. `bash hostgator-setup-kit/update.sh` (ou `install.sh`) liga o cron. Confirme:
   `bash hostgator-setup-kit/healthcheck.sh` → "monitor ativo no cron".
4. Aponte os alertas do monitor para **canais fora do CRM** (e-mail, app do celular, Telegram).
   **Nunca o WhatsApp do próprio CRM**: se o CRM cair, o alerta cai junto.
5. Em um monitor de site separado, vigie `https://SEU_DOMINIO/api/v1/health` (espere HTTP 200;
   503 é banco/Redis/WhatsApp fora).

Como funciona: a cada 5 minutos o `monitor.sh` confere Docker, cada serviço, a saúde do app,
disco, memória, certificado, reinício pendente e a idade do backup. Tudo bem → pinga a URL.
**Problema → pinga `<URL>/fail`** com o resumo no corpo. **Silêncio** → o monitor externo
alerta por conta própria (VPS morta, cron parado, rede fora).

Dois níveis: *problema* (o cliente já sente, ou vai sentir hoje) derruba o pinga; *aviso*
(vai virar problema se ninguém olhar) só vai no corpo. "Sem backup fora da VPS" é aviso
permanente até você configurar o §5 — de propósito, para não virar alarme que toca todo dia.

## 5. Backup fora da VPS (cifrado, que ninguém apaga)

O `backup.sh` antigo grava **no mesmo disco** da VPS: se ela morrer, o backup morre junto.
O `backup-fora.sh` leva para fora, **cifrado**: o banco, o `.env` (as chaves que decifram o
que o banco guarda cifrado — sem elas o banco restaurado é ilegível) e as sessões do WhatsApp
por QR code.

**Nada vai em claro**: cada arquivo nasce já cifrado, no próprio pipe (`pg_dump | gzip | age`).
Só a chave **pública** fica na VPS. Uma VPS invadida não decifra os backups antigos.

### 5.1 A chave que decifra (no seu computador, nunca na VPS)

```bash
age-keygen -o ~/elev-backup.key     # imprime a chave PÚBLICA (age1…); a privada fica no arquivo
```

Guarde `elev-backup.key` em **dois** lugares (cofre de senhas + cópia offline). **Perdeu a
chave privada = perdeu todos os backups.** A pública vai no `.env`.

### 5.2 O armazenamento (Backblaze B2)

1. Crie um bucket **privado com Object Lock ligado**, e uma retenção padrão (ex.: 30 dias).
   Object Lock só vale para arquivos gravados **depois** da regra (não protege o que já existe).
2. Crie uma **chave de aplicação restrita a esse bucket**, com listar e escrever arquivos e
   **sem apagar** (`deleteFiles`) e **sem** `bypassGovernance`. Confira os nomes exatos das
   permissões no painel do Backblaze — mudam de rótulo.
3. Uma regra de ciclo de vida no bucket apaga os backups velhos (ex.: depois de 90 dias). Quem
   expira é o bucket; o script não apaga nada.

Com isso, **quem invadir a VPS também não consegue destruir os backups**.

### 5.3 No `.env` da VPS

```
BACKUP_FORA_DESTINO=fora:NOME-DO-BUCKET/elevcrm
BACKUP_AGE_RECIPIENT=age1…          # a chave PÚBLICA. Várias, separadas por vírgula, valem (use uma de reserva)
RCLONE_CONFIG_FORA_TYPE=b2
RCLONE_CONFIG_FORA_ACCOUNT=<keyID da chave de aplicação>
RCLONE_CONFIG_FORA_KEY=<applicationKey>
```

### 5.4 Teste antes de confiar

```bash
bash hostgator-setup-kit/backup-fora.sh --teste   # acessa o destino, escreve, e TENTA APAGAR de propósito
bash hostgator-setup-kit/backup-fora.sh           # o backup de verdade
```

O `--teste` avisa em voz alta se a chave consegue apagar: aí o backup funciona, mas não
está protegido. O cron diário (03:17 UTC) é ligado pelo `install.sh`/`update.sh` quando as
duas variáveis existem. A saída vai para `.backup-fora.log`; o marcador `.backup-fora.ok`
só nasce depois de **enviar e conferir** — é nele que o monitor confia.

### 5.5 Prove que restaura (todo mês)

Um backup que nunca foi restaurado é uma hipótese. No **seu computador**, com a chave privada
e um `.env` pequeno (`BACKUP_FORA_DESTINO`, `RCLONE_CONFIG_*`, e `SUPABASE_DB_URL` se quiser
comparar com o banco vivo):

```bash
bash hostgator-setup-kit/testar-restauracao.sh --chave-privada ~/elev-backup.key --env ~/cliente.env
```

Ele baixa o backup mais recente, confere o hash de cada arquivo, decifra e carrega num
Postgres descartável, e compara o número de tabelas com o banco vivo. Termina com
**BACKUP PROVADO** ou com o motivo de **não** ter provado.

**O que isto não prova:** a volta para dentro de um Supabase (login, storage, extensões do
Supabase) — o banco descartável é um Postgres comum, e os erros de extensão são listados, não
escondidos. **Uma vez por trimestre** restaure num projeto Supabase descartável e confira que
o login e uma conversa abrem.

## 6. Rotina

| Quando | O quê |
|---|---|
| Todo dia | nada — você é avisado. Se o alerta tocar, vá ao §7. |
| Toda semana | olhe os **avisos** do monitor (`tail .monitor.log`): disco subindo, reinício pendente, certificado |
| Todo mês | `testar-restauracao.sh` (§5.5); `docker image prune` se o disco apertou |
| Todo trimestre | ensaio de restauração completo num Supabase descartável; revisar quem tem acesso à VPS e aos monitores |
| A cada versão nova | §6.1 |

### 6.1 Atualizar sem derrubar todos os clientes ao mesmo tempo

Uma instalação serve todos: uma atualização ruim derruba todos. Por isso:

1. **Ensaie antes** numa instalação de ensaio (outra VPS pequena, outro Supabase) com a mesma
   versão — o checklist de release exige o ensaio de atualização numa instalação real.
2. Atualize em horário de menor uso (madrugada), com `bash hostgator-setup-kit/update.sh`: ele
   faz backup antes, confere a saúde depois e **volta a imagem anterior** se o app novo não sobe.
3. Confirme: `GET /api/v1/health` com a versão nova e `healthy`; o domínio responde 307 (não 404).

## 7. Quando o alerta toca

Comece por: `bash hostgator-setup-kit/monitor.sh` (o que está errado) e
`bash hostgator-setup-kit/healthcheck.sh` (o estado de tudo).

| Mensagem | O que fazer |
|---|---|
| "o serviço 'X' está 'exited'/'restarting'" | `docker compose -f docker-compose.prod.yml logs --tail=100 X`; em geral falta chave no `.env` ou falta memória |
| "o app responde 'unhealthy'" | o corpo diz qual check caiu (banco, Redis, WhatsApp). Banco: veja o painel do Supabase |
| "disco … com 9x% de uso" | `docker system df`; `docker image prune`; logs já têm rotação |
| "o último backup fora da VPS tem Nh" | `tail .backup-fora.log`; rode `backup-fora.sh --teste` — quase sempre é credencial vencida ou bucket cheio |
| "o certificado HTTPS … vence em N dias" | DNS ainda aponta para a VPS? porta 80 aberta? `docker compose logs caddy` |
| Silêncio (o monitor externo alertou, a VPS nem responde) | §7.1 |

### 7.1 A VPS morreu

O CRM é quase sem estado local: o **banco está no Supabase** e a Meta guarda a conta.
Reconstruir é refazer o servidor, não restaurar dados.

1. Nova VPS → DNS para o novo IP → `preparar-host.sh` → clonar o repositório.
2. Recuperar o `.env`: baixe `env-<data>.age` do bucket e decifre com a sua chave privada
   (`age -d -i ~/elev-backup.key env-….age > .env`; `chmod 600 .env`). **Sem ele, as chaves de
   cifra se perdem e o que o banco guarda cifrado fica ilegível.**
3. `docker compose -f docker-compose.prod.yml up -d` (ou o `update.sh`). O endereço do
   webhook da Meta é o mesmo domínio, então não muda.
4. Sessões de WhatsApp por QR code: restaure `waha-<data>.tgz.age` no volume `waha-data`, ou
   re-escaneie o QR de cada número.
5. Confira `healthcheck.sh` e mande uma mensagem de teste.

**Quanto tempo leva: não medido.** O ensaio de reconstrução (derrubar uma VPS de ensaio e refazer
a partir só do bucket) é o que dá o número. Até lá, não prometa tempo de volta a cliente.

### 7.2 O banco foi apagado ou corrompido

Primeiro o backup do próprio Supabase (painel → Database → Backups; no Pro há 7 dias de backup
diário). Se precisar do nosso: `restore.sh` com o dump decifrado — **sobrescreve o banco**.

## 8. O que ainda NÃO está coberto (dito para a ausência não virar cobertura)

- **Arquivos do Storage** (fotos, áudios e documentos que os pacientes mandam; o bucket é o
  `whatsapp-media`): o backup do banco **não os inclui**. O backup do Supabase restaura a tabela
  que *lista* os arquivos, mas não os arquivos — nem o diário, nem o PITR, nem um `pg_dump`
  (fontes: a [issue do repositório de Storage do Supabase](https://github.com/supabase/storage/issues/789)
  e a [discussão aberta pedindo backup do Storage](https://github.com/orgs/supabase/discussions/39948);
  não li uma página oficial que diga isso, então confirme no painel). Hoje não há cópia nossa
  deles: apagados ou perdidos, não voltam. Para uma clínica, isto é a lacuna mais séria.
- **Tempo de reconstrução** (RTO): não medido (§7.1).
- **Perda máxima de dados** (RPO): até 24 h — o backup é diário. Menos que isso exige o
  recurso de restauração para um instante exato do Supabase (PITR), que é um adicional pago.
- **Uma VPS só**: não há segunda máquina esperando. Um provedor fora do ar derruba todos.
- **A Meta reenviando mensagens** enquanto o servidor está fora: não confirmei por quanto tempo
  ela tenta de novo. Prove no ensaio derrubando o endereço de propósito.
- **Capacidade**: o número de clientes que cabe numa VPS não foi medido.
- **Dados de saúde fora do Brasil**: o Backblaze não tem região no Brasil (até onde pude
  verificar — confirme no painel). Os arquivos vão cifrados e o provedor não tem a chave, mas a
  LGPD trata o envio de dado pessoal ao exterior como transferência internacional, com regras
  próprias. **Decida isso com quem cuida do jurídico da Elev** antes de levar dados de uma
  clínica para lá; a alternativa é um bucket S3 em São Paulo (também tem Object Lock). O
  Supabase deve estar na região de São Paulo.
- **Contrato com o cliente**: a Elev é operadora dos dados de cada cliente. Termos de
  tratamento de dados, e o que acontece com os backups quando o contrato acaba, precisam estar
  escritos antes de a primeira clínica entrar.
