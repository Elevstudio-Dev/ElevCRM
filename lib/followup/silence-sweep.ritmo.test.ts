/**
 * A varredura de silêncio COM ritmo, contra um banco em memória (sem Postgres):
 * um paciente por vez, intervalo entre eles, limite de 24h e a fila prevista.
 */
import { describe, expect, it } from "vitest";

import { esperaDepoisDe } from "./ritmo-de-entrada";
import {
  proximosDaFila,
  runSilenceSweep,
  type InscricoesRecentes,
  type SilencePointer,
  type SilenceSweepDb,
} from "./silence-sweep";

const ORG = "org-1";
const POINTER = "pointer-1";
const MIN = 60_000;
const RITMO = { min_minutos: 3, max_minutos: 9, limite_por_dia: 25 };

function pointer(ritmo: SilencePointer["ritmo"]): SilencePointer {
  return {
    id: POINTER,
    organization_id: ORG,
    active_version_id: "v1",
    threshold_minutes: 60,
    segments: [],
    ritmo,
  };
}

interface Inscricao {
  id: string;
  contactId: string;
  criadaEm: Date;
  vivo: boolean;
}

function bancoEmMemoria(p: SilencePointer, silentes: string[], inscricoes: Inscricao[] = []) {
  let seq = 0;
  const db: SilenceSweepDb & { inscricoes: Inscricao[]; agora: Date } = {
    inscricoes,
    agora: new Date("2026-11-18T15:00:00.000Z"),
    async loadActiveSilencePointers() {
      return [p];
    },
    async loadSilentContactIds() {
      return silentes;
    },
    async loadLiveContactIds() {
      return new Set(inscricoes.filter((i) => i.vivo).map((i) => i.contactId));
    },
    async loadInscricoesRecentes(_pointerId, sinceIso): Promise<InscricoesRecentes> {
      const desde = new Date(sinceIso).getTime();
      const todas = [...inscricoes].sort((a, b) => a.criadaEm.getTime() - b.criadaEm.getTime());
      const nasJanela = todas.filter((i) => i.criadaEm.getTime() >= desde);
      const ult = nasJanela[nasJanela.length - 1];
      return {
        criadasEm: nasJanela.map((i) => i.criadaEm),
        ultima: ult ? { id: ult.id, criadaEm: ult.criadaEm } : null,
      };
    },
    async loadTriggerNodeId() {
      return "trigger";
    },
    async insertEnrollment(input) {
      if (inscricoes.some((i) => i.vivo && i.contactId === input.contact_id)) {
        return { inserted: false };
      }
      seq += 1;
      inscricoes.push({
        id: `insc-${seq}`,
        contactId: input.contact_id,
        criadaEm: new Date(input.next_eval_at),
        vivo: true,
      });
      return { inserted: true };
    },
  };
  return db;
}

const gateDb = {
  async loadEnabledPublishedFollowupAgents() {
    return [{ agentId: "agent-1", pointerIds: [POINTER] }];
  },
};

async function varrer(db: ReturnType<typeof bancoEmMemoria>) {
  return runSilenceSweep({ db, gateDb, clock: () => db.agora });
}

describe("silence-sweep com ritmo", () => {
  it("sem ritmo, mantém o comportamento original: todos entram de uma vez", async () => {
    const db = bancoEmMemoria(pointer(null), ["a", "b", "c"]);
    const r = await varrer(db);
    expect(r.enrolled).toBe(3);
    expect(r.deferred_by_pacing).toBe(0);
  });

  it("com ritmo, entra UM por varredura", async () => {
    const db = bancoEmMemoria(pointer(RITMO), ["a", "b", "c"]);
    const r = await varrer(db);
    expect(r.enrolled).toBe(1);
    expect(db.inscricoes.map((i) => i.contactId)).toEqual(["a"]);
  });

  it("a varredura seguinte, ainda dentro do intervalo, não inscreve ninguém", async () => {
    const db = bancoEmMemoria(pointer(RITMO), ["a", "b", "c"]);
    await varrer(db);
    db.agora = new Date(db.agora.getTime() + 1 * MIN); // 1 min < mínimo de 3
    const r = await varrer(db);
    expect(r.enrolled).toBe(0);
    expect(r.deferred_by_pacing).toBe(1);
  });

  it("vencido o intervalo daquela inscrição, entra o próximo, na ordem", async () => {
    const db = bancoEmMemoria(pointer(RITMO), ["a", "b", "c"]);
    await varrer(db);
    const espera = esperaDepoisDe("insc-1", RITMO);
    db.agora = new Date(db.agora.getTime() + espera * MIN);
    const r = await varrer(db);
    expect(r.enrolled).toBe(1);
    expect(db.inscricoes.map((i) => i.contactId)).toEqual(["a", "b"]);
  });

  it("pula quem já tem follow-up vivo e entra o próximo da fila", async () => {
    const velha = new Date("2026-11-17T10:00:00.000Z"); // fora do intervalo, dentro das 24h
    const db = bancoEmMemoria(pointer(RITMO), ["a", "b"], [
      { id: "x", contactId: "a", criadaEm: velha, vivo: true },
    ]);
    const r = await varrer(db);
    expect(r.enrolled).toBe(1);
    expect(r.skipped_existing).toBe(1);
    expect(db.inscricoes.map((i) => i.contactId)).toEqual(["a", "b"]);
  });

  it("no limite de 24h, nada entra e conta como adiado pelo ritmo", async () => {
    const ritmo = { min_minutos: 3, max_minutos: 3, limite_por_dia: 2 };
    const agora = new Date("2026-11-18T15:00:00.000Z");
    const antigas: Inscricao[] = [1, 2].map((n) => ({
      id: `old-${n}`,
      contactId: `ja-${n}`,
      criadaEm: new Date(agora.getTime() - (n * 60 + 30) * MIN),
      vivo: false,
    }));
    const db = bancoEmMemoria(pointer(ritmo), ["novo"], antigas);
    const r = await varrer(db);
    expect(r.enrolled).toBe(0);
    expect(r.deferred_by_pacing).toBe(1);
  });
});

describe("proximosDaFila", () => {
  it("sem ritmo, não há fila a mostrar", async () => {
    const db = bancoEmMemoria(pointer(null), ["a", "b"]);
    expect(await proximosDaFila(db, pointer(null), () => db.agora, 10)).toEqual([]);
  });

  it("lista só quem ainda não está vivo, na ordem, com a hora prevista crescente", async () => {
    const velha = new Date("2026-11-17T10:00:00.000Z");
    const db = bancoEmMemoria(pointer(RITMO), ["a", "b", "c", "d"], [
      { id: "x", contactId: "a", criadaEm: velha, vivo: true },
    ]);
    const fila = await proximosDaFila(db, pointer(RITMO), () => db.agora, 2);
    expect(fila.map((f) => f.contactId)).toEqual(["b", "c"]);
    expect(fila.map((f) => f.posicao)).toEqual([1, 2]);
    expect(fila[1]!.entraEm.getTime() - fila[0]!.entraEm.getTime()).toBe(6 * MIN);
  });
});
