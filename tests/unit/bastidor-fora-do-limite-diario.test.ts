/**
 * A conversa com a equipe (bastidor: secretaria, marketing) NÃO conta no limite diário do número
 * (decisão do dono, 17/11): não é barrada pelo teto de warm-up/diário e não gasta a cota das vendas.
 *
 * Três provas, do motor à cadeia:
 *  1. o motor: `ignoreDailyCaps` passa onde o teto vetaria — e a janela horária continua valendo;
 *  2. o gate: o contexto do bastidor liga isso sozinho, o de vendas não;
 *  3. a cadeia inteira: o bastidor envia com o teto estourado e NÃO grava no `pacing_ledger`
 *     (o controle — um envio de vendas — grava).
 */
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { pacingGate, runBeforeSend, type GateContext } from '@/lib/agent-engine/guardrails/before-send';
import { decidePacing } from '@/lib/agent-engine/pacing/engine';
import { PACING_DEFAULTS } from '@/lib/agent-engine/pacing/defaults';
import { SPINNING_DEFAULTS } from '@/lib/agent-engine/spinning/defaults';
import type { Logger } from '@/lib/agent-engine/obs/logger';

const COMERCIAL = new Date('2026-07-28T13:00:00Z'); // 10h BRT, terça — dentro da janela
const MADRUGADA = new Date('2026-07-28T06:00:00Z'); // 03h BRT — fora da janela

const ESTOURADO = { lastSentAt: null, sentToday: 999, numberActivatedAt: null };

describe('motor de pacing: ignoreDailyCaps', () => {
  const base = { now: COMERCIAL, knobs: PACING_DEFAULTS, state: ESTOURADO, crmDailyLimit: 20, rng: () => 0 };

  it('sem a opção, o teto estourado veta (controle)', () => {
    const d = decidePacing(base);
    expect(d.allow).toBe(false);
  });

  it('com a opção, passa onde o teto vetaria', () => {
    const d = decidePacing({ ...base, ignoreDailyCaps: true });
    expect(d.allow).toBe(true);
  });

  it('a janela horária continua valendo (cortesia não é teto)', () => {
    const d = decidePacing({ ...base, now: MADRUGADA, ignoreDailyCaps: true });
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('outside_window');
  });
});

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: COMERCIAL,
    body: 'oi',
    optedOut: false,
    provider: 'waha',
    pacing: { knobs: PACING_DEFAULTS, state: ESTOURADO, crmDailyLimit: 20, rng: () => 0 },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: 'inject' },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

describe('gate de pacing: o contexto do bastidor liga a isenção sozinho', () => {
  it('vendas com o teto estourado: veta', () => {
    const v = pacingGate.evaluate(ctx());
    expect(v.pass).toBe(false);
  });

  it('bastidor com o teto estourado: passa', () => {
    const v = pacingGate.evaluate(ctx({ bastidor: { tipo: 'agenda_conferencia' }, papelInterno: 'secretaria' }));
    expect(v.pass).toBe(true);
  });
});

describe('cadeia inteira: o envio do bastidor não entra na contagem do dia', () => {
  async function roda(bastidor: boolean, enviadasHoje = 999) {
    const gravouNoLedger = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        const q = String(sql);
        if (q.includes('insert into pacing_ledger')) gravouNoLedger();
        if (q.includes('from channel_sessions')) return { rows: [{ provider: 'waha' }] };
        if (q.includes('from pacing_ledger')) return { rows: [{ last_sent_at: null, sent_today: String(enviadasHoje) }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const persisted = vi.fn().mockResolvedValue({ rows: [{ id: 'trace-1' }] });
    const pool = { connect: vi.fn().mockResolvedValue(client), query: persisted } as unknown as pg.Pool;
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await runBeforeSend({
      pool,
      log,
      tenantId: '00000000-0000-4000-8000-000000000001',
      leadId: '00000000-0000-4000-8000-000000000002',
      jobId: '00000000-0000-4000-8000-000000000003',
      channelSessionId: '00000000-0000-4000-8000-000000000004',
      body: 'oi',
      optedOutThisTurn: false,
      crmDailyLimit: 20,
      now: COMERCIAL,
      rng: () => 0,
      sleep: async () => {},
      gates: [pacingGate],
      ...(bastidor ? { bastidor: { tipo: 'agenda_conferencia' as const } } : {}),
      send: async () => ({ kind: 'sent', idempotencyKey: 'k', messageId: 'm' }),
    });
    return { result, gravouNoLedger };
  }

  it('vendas com o teto estourado: vetado, e nada é gravado', async () => {
    const { result, gravouNoLedger } = await roda(false);
    expect(result.status).toBe('vetoed');
    expect(gravouNoLedger).not.toHaveBeenCalled();
  });

  it('controle: vendas com o teto livre enviam E gravam no pacing_ledger (o teste enxerga a gravação)', async () => {
    const { result, gravouNoLedger } = await roda(false, 0);
    expect(result.status).toBe('sent');
    expect(gravouNoLedger).toHaveBeenCalledTimes(1);
  });

  it('bastidor com o teto estourado: enviado, e NÃO grava no pacing_ledger', async () => {
    const { result, gravouNoLedger } = await roda(true);
    expect(result.status).toBe('sent');
    expect(gravouNoLedger).not.toHaveBeenCalled();
  });
});
