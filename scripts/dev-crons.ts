/**
 * Relógio local dos crons HTTP. Em prod o crontab da VPS chama as mesmas
 * rotas; o Next em `pnpm dev` não chama sozinho.
 *
 * ─── Ele lê a agenda de PRODUÇÃO, e não uma lista própria ───────────────────
 *
 * Até 2026-09-22 este arquivo tinha um array com DUAS rotas
 * (`event-log-drain`, `followup-flow-worker`) enquanto o scheduler roda
 * VINTE E UMA. O preço apareceu na tela do dono: `contact-avatars` roda a cada
 * 10 min em produção e nunca rodava aqui — a foto dos contatos não atualizava
 * na máquina de desenvolvimento, sem erro e sem log. Uma feature que "não
 * acontece" é mais difícil de achar que uma que quebra.
 *
 * Agora a lista sai de `docker/scheduler/entrypoint.sh`, pelo mesmo parser que
 * a cerca `cron-routes-scheduled` usa (`scripts/agenda-dos-crons.ts`). Rota
 * nova agendada em produção passa a rodar aqui sem ninguém lembrar de editar
 * este arquivo.
 *
 * ─── O que NÃO roda sozinho aqui ────────────────────────────────────────────
 *
 * Os crons DIÁRIOS (`data-retention`, `kb-conversations-batch`,
 * `sync-model-catalog`, `lgpd-sla-watcher`). Eles apagam ou reprocessam em
 * lote; disparar isso no minuto em que alguém sobe o relógio local é surpresa
 * cara numa base de desenvolvimento com dados reais. Rode com `--tudo` quando
 * for o que você quer.
 *
 * Não mexe em produção: só faz POST em NEXT_PUBLIC_APP_URL (default
 * localhost:3000). O risco é o *banco*: se .env.local aponta para o mesmo
 * Supabase da VPS, este loop compete com o cron de lá.
 *
 * Uso (app já no ar):
 *   pnpm dev:crons                 # tudo que roda de hora em hora ou mais
 *   pnpm dev:crons --tudo          # inclusive os diários
 *   DEV_CRON_BASE=http://localhost:3100 pnpm dev:crons
 */
import { agendaDosCrons, type CronAgendado } from "./agenda-dos-crons";

/** De quanto em quanto tempo o laço acorda para ver quem venceu. */
const TICK_MS = Number(process.env.DEV_CRON_INTERVAL_MS ?? "15000");
/** Acima disto é "diário": só com `--tudo`. */
const LIMITE_SEM_TUDO_MS = 12 * 60 * 60 * 1000;

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`${name} ausente — rode com --env-file=.env.local`);
  }
  return v;
}

function supabaseHost(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").host || "(sem URL)";
  } catch {
    return "(URL inválida)";
  }
}

async function chamar(base: string, secret: string, cron: CronAgendado): Promise<void> {
  const controle = new AbortController();
  const corta = setTimeout(() => controle.abort(), cron.timeoutSegundos * 1000);
  try {
    // GET, como o scheduler: o entrypoint chama `curl -fsS` SEM `-X`, e cinco
    // rotas (attendant-heartbeat, webhook-log-retention, storage-redaction,
    // kb-conversations-batch, lgpd-sla-watcher) só exportam GET. Este relógio
    // mandava POST e levava 405 nelas — mais uma forma de "roda em produção,
    // não roda aqui". Medido em 2026-09-22.
    const res = await fetch(`${base}${cron.caminho}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
      signal: controle.signal,
    });
    const body = await res.text();
    const snippet = body.length > 240 ? `${body.slice(0, 240)}…` : body;
    console.info(`[dev-crons] ${cron.caminho} → ${res.status} ${snippet}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[dev-crons] ${cron.caminho} → falhou: ${msg}`);
  } finally {
    clearTimeout(corta);
  }
}

async function main(): Promise<void> {
  const tudo = process.argv.includes("--tudo");
  const base = (
    process.env.DEV_CRON_BASE ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
  const secret = process.env.INTERNAL_CRON_SECRET?.trim() || requiredEnv("INTERNAL_SECRET");

  const agenda = agendaDosCrons().filter((c) => tudo || c.periodoMs <= LIMITE_SEM_TUDO_MS);
  const diarios = agendaDosCrons().length - agenda.length;

  console.info("[dev-crons] alvo HTTP", base);
  console.info("[dev-crons] banco (Supabase)", supabaseHost());
  console.info(
    "[dev-crons] se esse host for o da VPS, pare — o drain local disputa event_log/job_queue com produção",
  );
  console.info(
    `[dev-crons] ${agenda.length} cron(s) da agenda de produção` +
      (diarios > 0 ? `; ${diarios} diário(s) fora — use --tudo para incluí-los` : ""),
  );
  console.info(`[dev-crons] tique ${TICK_MS}ms — Ctrl+C encerra`);

  // `0` e não `Date.now()`: todo cron vence no primeiro tique, para o relógio
  // "recuperar o atraso" de quem não rodava desde a última sessão. É o que faz
  // a foto do contato aparecer logo depois de subir, em vez de dez minutos
  // depois.
  const ultimo = new Map<string, number>(agenda.map((c) => [c.caminho, 0]));

  const tique = async (): Promise<void> => {
    const agora = Date.now();
    for (const cron of agenda) {
      if (agora - (ultimo.get(cron.caminho) ?? 0) < cron.periodoMs) continue;
      ultimo.set(cron.caminho, agora);
      await chamar(base, secret, cron);
    }
  };

  await tique();
  setInterval(() => {
    void tique().catch((err: unknown) => {
      console.error("[dev-crons] tique falhou", err instanceof Error ? err.message : err);
    });
  }, TICK_MS);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
