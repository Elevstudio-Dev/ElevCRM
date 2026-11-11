// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { MensagemDoHistorico } from "@/lib/channels/historico";
import { importarHistoricoDoContato, statusDaMensagemImportada } from "@/lib/inbox/importar-historico";

/**
 * A gravação do histórico. Um banco em memória mínimo (só o que o módulo usa) basta: a regra está em QUEM é
 * gravado, COMO (marcas, status) e no que NÃO se mexe (contador de não lidas, data da conversa para trás).
 */
const ORG = "org-1";
const ALVO = { organizationId: ORG, contactId: "ct-1", conversationId: "cv-1", channelSessionId: "se-1" };

type Linha = Record<string, unknown>;
interface Estado {
  messages: Linha[];
  conversations: Linha[];
  contacts: Linha[];
  rpcs: Array<{ nome: string; args: Record<string, unknown> }>;
  /** Faz o INSERT de lote falhar uma vez com colisão, para exercitar o caminho linha a linha. */
  colidirNoLote?: boolean;
}

class Consulta {
  private filtros: Array<(l: Linha) => boolean> = [];
  private modo: "select" | "insert" | "update" = "select";
  private payload: Linha | Linha[] | null = null;
  private faixa: [number, number] | null = null;
  private unico = false;

  constructor(private readonly e: Estado, private readonly tabela: "messages" | "conversations" | "contacts") {}

  select() {
    return this;
  }
  eq(coluna: string, valor: unknown) {
    this.filtros.push((l) => l[coluna] === valor);
    return this;
  }
  not(coluna: string, _op: string, valor: unknown) {
    this.filtros.push((l) => l[coluna] !== valor);
    return this;
  }
  order() {
    return this;
  }
  range(de: number, ate: number) {
    this.faixa = [de, ate];
    return this;
  }
  maybeSingle() {
    this.unico = true;
    return this;
  }
  insert(p: Linha | Linha[]) {
    this.modo = "insert";
    this.payload = p;
    return this;
  }
  update(p: Linha) {
    this.modo = "update";
    this.payload = p;
    return this;
  }

  then(resolve: (v: { data: unknown; error: { code?: string; message: string } | null }) => void) {
    const tabela = this.e[this.tabela];
    const casa = (l: Linha) => this.filtros.every((f) => f(l));
    if (this.modo === "insert") {
      const linhas = Array.isArray(this.payload) ? this.payload : [this.payload as Linha];
      const colide = (l: Linha) => tabela.some((x) => x.organization_id === l.organization_id && x.external_id === l.external_id);
      if (this.e.colidirNoLote && linhas.length > 1) {
        this.e.colidirNoLote = false;
        return resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
      }
      if (linhas.some(colide) && linhas.length === 1) {
        return resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
      }
      for (const l of linhas) if (!colide(l)) tabela.push({ id: `m${tabela.length}`, ...l });
      return resolve({ data: null, error: null });
    }
    if (this.modo === "update") {
      for (const l of tabela.filter(casa)) Object.assign(l, this.payload);
      return resolve({ data: null, error: null });
    }
    let achadas = tabela.filter(casa);
    if (this.faixa) achadas = achadas.slice(this.faixa[0], this.faixa[1] + 1);
    return resolve({ data: this.unico ? (achadas[0] ?? null) : achadas, error: null });
  }
}

function criar(parcial: Partial<Estado> = {}) {
  const estado: Estado = {
    messages: [],
    conversations: [{ id: "cv-1", organization_id: ORG, last_message_at: null, last_inbound_at: null, last_outbound_at: null, unread_count_for_assignee: 4 }],
    contacts: [{ id: "ct-1", organization_id: ORG, source_metadata: {} }],
    rpcs: [],
    ...parcial,
  };
  const admin = {
    from: (t: "messages" | "conversations" | "contacts") => new Consulta(estado, t),
    rpc: (nome: string, args: Record<string, unknown>) => {
      estado.rpcs.push({ nome, args });
      return Promise.resolve({ error: null });
    },
  } as unknown as SupabaseClient;
  return { estado, admin };
}

let n = 0;
const msg = (over: Partial<MensagemDoHistorico> = {}): MensagemDoHistorico => {
  n += 1;
  const id = `false_5511@c.us_ID${n}`;
  return {
    externalId: id,
    idsEquivalentes: [id, `ID${n}`, `true_5511@c.us_ID${n}`],
    direcao: "inbound",
    enviadaEm: `2025-03-0${Math.min(n, 9)}T10:00:00.000Z`,
    tipo: "text",
    texto: `mensagem ${n}`,
    temMidia: false,
    mediaMime: null,
    ack: 3,
    nomeDoContato: null,
    anuncio: null,
    ...over,
  };
};

const anuncio = { plataforma: "meta_ads" as const, sourceId: "CLID", titulo: "Clareamento v1", corpo: null, sourceUrl: "https://fb.me/x", bruto: {} };

describe("importarHistoricoDoContato", () => {
  it("grava as novas, marcadas como importadas, do mais antigo para o mais novo", async () => {
    const { estado, admin } = criar();
    const a = msg({ enviadaEm: "2025-03-02T10:00:00.000Z" });
    const b = msg({ enviadaEm: "2025-03-01T10:00:00.000Z" });
    const r = await importarHistoricoDoContato(admin, ALVO, [a, b]);
    expect(r).toMatchObject({ encontradas: 2, importadas: 2, jaExistiam: 0, falharam: 0 });
    expect(estado.messages.map((m) => m.external_id)).toEqual([b.externalId, a.externalId]);
    expect(estado.messages.every((m) => (m.metadata as Linha).historico_importado === true)).toBe(true);
    expect(estado.messages[0]).toMatchObject({
      organization_id: ORG,
      conversation_id: "cv-1",
      channel_session_id: "se-1",
      contact_id: "ct-1",
      sent_via: "external_device",
      status: "delivered",
    });
    expect(r.primeiraEm).toBe("2025-03-01T10:00:00.000Z");
    expect(r.ultimaEm).toBe("2025-03-02T10:00:00.000Z");
  });

  it("não duplica o que já está no CRM, em qualquer forma de id (composto ou cru)", async () => {
    const { estado, admin } = criar();
    const jaChegou = msg();
    const saiuPeloCrm = msg({ direcao: "outbound" });
    const nova = msg();
    estado.messages.push(
      { id: "x1", organization_id: ORG, contact_id: "ct-1", external_id: jaChegou.externalId, metadata: {} },
      // O envio do CRM grava o id CRU; o histórico traz o composto.
      { id: "x2", organization_id: ORG, contact_id: "ct-1", external_id: `ID${n - 1}`, metadata: {} },
    );
    const r = await importarHistoricoDoContato(admin, ALVO, [jaChegou, saiuPeloCrm, nova]);
    expect(r).toMatchObject({ encontradas: 3, importadas: 1, jaExistiam: 2 });
    expect(estado.messages).toHaveLength(3);
  });

  it("rodar duas vezes não duplica nada", async () => {
    const { estado, admin } = criar();
    const lote = [msg(), msg(), msg()];
    await importarHistoricoDoContato(admin, ALVO, lote);
    const segunda = await importarHistoricoDoContato(admin, ALVO, lote);
    expect(segunda).toMatchObject({ importadas: 0, jaExistiam: 3 });
    expect(estado.messages).toHaveLength(3);
  });

  it("uma colisão no lote cai no insert linha a linha e é contada, sem derrubar as outras", async () => {
    const { estado, admin } = criar({ colidirNoLote: true });
    const a = msg();
    const b = msg();
    // `b` entra na base DEPOIS da leitura das existentes (corrida com a ingestão ao vivo): simula pondo-a no insert.
    const r = await importarHistoricoDoContato(admin, ALVO, [a, b]);
    expect(r.importadas + r.jaExistiam).toBe(2);
    expect(r.falharam).toBe(0);
    expect(estado.messages).toHaveLength(2);
  });

  it("NUNCA mexe no contador de não lidas e nunca dispara efeito (RPCs de efeito, evento, agente)", async () => {
    const { estado, admin } = criar();
    await importarHistoricoDoContato(admin, ALVO, [msg({ enviadaEm: "2025-03-05T10:00:00.000Z" })]);
    expect(estado.conversations[0]!.unread_count_for_assignee).toBe(4);
    expect(estado.rpcs.map((r) => r.nome)).not.toEqual(
      expect.arrayContaining(["fn_mark_conversation_message", "emit_event"]),
    );
  });

  it("a conversa passa a mostrar a mensagem mais nova do histórico, mas nunca anda para trás", async () => {
    const { estado, admin } = criar();
    estado.conversations[0]!.last_message_at = "2025-03-20T00:00:00.000Z";
    await importarHistoricoDoContato(admin, ALVO, [msg({ enviadaEm: "2025-03-02T10:00:00.000Z" })]);
    expect(estado.conversations[0]!.last_message_at).toBe("2025-03-20T00:00:00.000Z");

    const vazia = criar();
    await importarHistoricoDoContato(vazia.admin, ALVO, [
      msg({ enviadaEm: "2025-03-02T10:00:00.000Z", texto: "ultima" }),
    ]);
    expect(vazia.estado.conversations[0]).toMatchObject({
      last_message_at: "2025-03-02T10:00:00.000Z",
      last_message_preview: "ultima",
      last_inbound_at: "2025-03-02T10:00:00.000Z",
    });
    expect(vazia.estado.conversations[0]!.last_outbound_at).toBeNull();
  });

  it("identifica o anúncio na mensagem e carimba o contato pela mais antiga", async () => {
    const { estado, admin } = criar();
    const antiga = msg({ enviadaEm: "2025-03-01T08:00:00.000Z", anuncio });
    const recente = msg({ enviadaEm: "2025-03-09T08:00:00.000Z", anuncio: { ...anuncio, titulo: "Outro" } });
    const r = await importarHistoricoDoContato(admin, ALVO, [recente, antiga]);
    expect(r.deAnuncio).toBe(2);
    expect(r.contatoMarcadoComoAnuncio).toBe(true);
    const marcada = estado.messages.find((m) => m.external_id === antiga.externalId);
    expect((marcada!.metadata as Linha).anuncio).toEqual({
      plataforma: "meta_ads",
      titulo: "Clareamento v1",
      codigo: "CLID",
      url: "https://fb.me/x",
    });
    const carimbos = estado.rpcs.filter((x) => x.nome === "fn_estampar_atribuicao_de_anuncio");
    expect(carimbos).toHaveLength(1);
    expect((carimbos[0]!.args.p_metadata as Linha).ad_title).toBe("Clareamento v1");
  });

  it("contato que já tinha origem não é re-marcado (primeiro toque)", async () => {
    const { estado, admin } = criar();
    estado.contacts[0]!.source_metadata = { ad_platform: "meta_ads" };
    const r = await importarHistoricoDoContato(admin, ALVO, [msg({ anuncio })]);
    expect(r.contatoMarcadoComoAnuncio).toBe(false);
  });

  it("mensagem que JÁ estava no CRM sem a marca de anúncio é completada", async () => {
    const { estado, admin } = criar();
    const m = msg({ anuncio });
    estado.messages.push({ id: "x1", organization_id: ORG, contact_id: "ct-1", external_id: m.externalId, metadata: { raw_type: "chat" } });
    const r = await importarHistoricoDoContato(admin, ALVO, [m]);
    expect(r).toMatchObject({ importadas: 0, jaExistiam: 1 });
    expect(estado.messages[0]!.metadata).toMatchObject({
      raw_type: "chat",
      anuncio: { titulo: "Clareamento v1", codigo: "CLID" },
    });
  });

  it("anexo entra como linha marcada, sem arquivo", async () => {
    const { estado, admin } = criar();
    await importarHistoricoDoContato(admin, ALVO, [msg({ tipo: "image", texto: null, temMidia: true, mediaMime: "image/jpeg" })]);
    expect(estado.messages[0]).toMatchObject({ type: "image", body: null, media_mime: "image/jpeg" });
    expect(estado.messages[0]!.media_url).toBeUndefined();
    expect((estado.messages[0]!.metadata as Linha).midia_nao_importada).toBe(true);
  });

  it("tipo fora do vocabulário vira texto (a constraint recusaria a linha inteira)", async () => {
    const { estado, admin } = criar();
    await importarHistoricoDoContato(admin, ALVO, [msg({ tipo: "poll_creation" })]);
    expect(estado.messages[0]!.type).toBe("text");
  });

  it("sem mensagens não toca em nada", async () => {
    const { estado, admin } = criar();
    const r = await importarHistoricoDoContato(admin, ALVO, []);
    expect(r).toMatchObject({ encontradas: 0, importadas: 0 });
    expect(estado.rpcs).toHaveLength(0);
  });
});

describe("statusDaMensagemImportada", () => {
  it("entrada já foi entregue a nós", () => {
    expect(statusDaMensagemImportada("inbound", null)).toBe("delivered");
  });
  it("saída segue o último recibo e NUNCA vira falha (o -1 de mensagem antiga é ruído)", () => {
    expect(statusDaMensagemImportada("outbound", 3)).toBe("read");
    expect(statusDaMensagemImportada("outbound", 2)).toBe("delivered");
    expect(statusDaMensagemImportada("outbound", 1)).toBe("sent");
    expect(statusDaMensagemImportada("outbound", 0)).toBe("sent");
    expect(statusDaMensagemImportada("outbound", -1)).toBe("sent");
    expect(statusDaMensagemImportada("outbound", null)).toBe("sent");
  });
});
