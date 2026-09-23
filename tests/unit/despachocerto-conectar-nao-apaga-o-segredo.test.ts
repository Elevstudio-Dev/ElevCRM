import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SALVAR DE NOVO NÃO PODE REPROVAR — nem apagar o segredo que já existe.
 *
 * `tenant_integrations.webhook_secret_encrypted` é NOT NULL. Quem salva a tela
 * só para corrigir a URL não rotaciona o segredo, então a coluna fica fora do
 * patch. Com `upsert`, isso reprovava: o Postgres monta a tupla do INSERT e
 * valida o NOT NULL ANTES de detectar o conflito, então mesmo com a linha
 * existindo — caminho de update — a gravação morria com
 *
 *     null value in column "webhook_secret_encrypted" violates not-null
 *
 * e a tela devolvia 500. Medido na primeira conexão real, 23/09.
 *
 * O que estes casos prendem:
 *
 *  - **linha existe → UPDATE.** Nunca um insert que precise recompor colunas
 *    que ninguém pediu para mudar.
 *  - **o UPDATE é da organização certa.** Sem os dois filtros, salvar a tela de
 *    uma organização reescreveria a integração de outra.
 *  - **não rotacionar não manda a coluna.** É o que garante que o segredo
 *    colado no outro sistema continua valendo — reescrevê-lo "por garantia"
 *    invalidaria a integração de quem só arrumou um endereço.
 *  - **linha nova → INSERT com o segredo.** No único caminho que cria a linha,
 *    a coluna obrigatória vai junto.
 */

const chamadas: Array<{ tabela: string; op: string; patch: unknown; filtros: Array<[string, unknown]> }> = [];
let linhaExistente: Record<string, unknown> | null = null;

class Q implements PromiseLike<unknown> {
  private filtros: Array<[string, unknown]> = [];
  constructor(
    private readonly tabela: string,
    private readonly op: string,
    private readonly patch: unknown = null,
  ) {}
  select(): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filtros.push([col, val]);
    return this;
  }
  private resolver() {
    if (this.op === "select") {
      return { data: linhaExistente, error: null };
    }
    chamadas.push({ tabela: this.tabela, op: this.op, patch: this.patch, filtros: this.filtros });
    return {
      data: {
        id: "int-1",
        organization_id: "org-1",
        status: "healthy",
        status_reason: null,
        store_metadata: { base_url: "https://dc.example.test" },
        webhook_path_token: "tok",
        oauth_access_token_encrypted: "\\xaa",
        webhook_secret_encrypted: "\\xbb",
        last_health_check_at: null,
      },
      error: null,
    };
  }
  maybeSingle() {
    return Promise.resolve(this.resolver());
  }
  single() {
    return Promise.resolve(this.resolver());
  }
  then<R1, R2>(ok?: ((v: unknown) => R1 | PromiseLike<R1>) | null, err?: ((r: unknown) => R2 | PromiseLike<R2>) | null) {
    return Promise.resolve(this.resolver()).then(ok, err);
  }
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => new Q(tabela, "select"),
      update: (patch: unknown) => new Q(tabela, "update", patch),
      insert: (patch: unknown) => new Q(tabela, "insert", patch),
      upsert: (patch: unknown) => new Q(tabela, "upsert", patch),
    }),
  }),
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: () => ({
    ciphertext: Buffer.from("cifra"),
    iv: Buffer.alloc(12, 1),
    tag: Buffer.alloc(16, 2),
    last4: "0000",
  }),
  decryptKey: () => "segredo",
  bufToBytea: (b: Buffer) => `\\x${b.toString("hex")}`,
  byteaToBuffer: (v: unknown) => Buffer.from(String(v).replace(/^\\x/, ""), "hex"),
}));

const { conectar } = await import("@/lib/integrations/despachocerto/estado");

const LINHA = {
  id: "int-1",
  organization_id: "org-1",
  status: "healthy",
  status_reason: null,
  store_metadata: { base_url: "http://antigo.test" },
  webhook_path_token: "tok-que-ja-esta-colado-la",
  oauth_access_token_encrypted: "\\xaa",
  webhook_secret_encrypted: "\\xbb",
  last_health_check_at: null,
};

beforeEach(() => {
  chamadas.length = 0;
  linhaExistente = null;
});

/** A escrita que aconteceu — falha dizendo o que faltou, e não `undefined`. */
function escrita() {
  const c = chamadas[0];
  if (!c) throw new Error("nenhuma escrita foi feita em tenant_integrations");
  return c;
}

describe("conectar a integração do Despacho Certo", () => {
  it("com a linha já existente, ATUALIZA — não tenta inserir de novo", async () => {
    linhaExistente = LINHA;

    await conectar("org-1", { baseUrl: "https://dc.example.test", chave: "chave-nova" });

    expect(chamadas).toHaveLength(1);
    expect(escrita().op).toBe("update");
    expect(escrita().tabela).toBe("tenant_integrations");
  });

  it("o UPDATE é preso na organização e no provedor", async () => {
    linhaExistente = LINHA;

    await conectar("org-1", { baseUrl: "https://dc.example.test", chave: "chave-nova" });

    expect(escrita().filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", "org-1"],
        ["provider", "despachocerto"],
      ]),
    );
  });

  it("sem rotacionar, NÃO manda a coluna do segredo — o que já está colado lá continua valendo", async () => {
    linhaExistente = LINHA;

    const { segredoEmClaro } = await conectar("org-1", {
      baseUrl: "https://dc.example.test",
      chave: "chave-nova",
    });

    expect(segredoEmClaro).toBeNull();
    expect(escrita().patch).not.toHaveProperty("webhook_secret_encrypted");
  });

  it("rotacionando, manda a coluna e devolve o segredo UMA vez", async () => {
    linhaExistente = LINHA;

    const { segredoEmClaro } = await conectar("org-1", {
      baseUrl: "https://dc.example.test",
      chave: "chave-nova",
      rotacionarSegredo: true,
    });

    expect(segredoEmClaro).toBeTruthy();
    expect(escrita().patch).toHaveProperty("webhook_secret_encrypted");
  });

  it("sem linha nenhuma, INSERE já com a coluna obrigatória preenchida", async () => {
    linhaExistente = null;

    const { segredoEmClaro } = await conectar("org-2", {
      baseUrl: "https://dc.example.test",
      chave: "chave-nova",
    });

    expect(escrita().op).toBe("insert");
    expect(segredoEmClaro).toBeTruthy();
    expect(escrita().patch).toHaveProperty("webhook_secret_encrypted");
  });

  it("o token do caminho é preservado: ele já está colado no outro sistema", async () => {
    linhaExistente = LINHA;

    await conectar("org-1", { baseUrl: "https://dc.example.test", chave: "chave-nova" });

    expect((escrita().patch as Record<string, unknown>).webhook_path_token).toBe(
      "tok-que-ja-esta-colado-la",
    );
  });
});
