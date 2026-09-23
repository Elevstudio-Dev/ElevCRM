/**
 * A TRAVESSIA ROTA → HOOK DO DESPACHO CERTO — o envelope, sob gate.
 *
 * ─── O defeito que esta cerca fecha ──────────────────────────────────────────
 *
 * As rotas desta base respondem `{"data": …}` — é o que `ok()` monta — e
 * `apiClient` entrega o corpo INTEIRO, sem desembrulhar. Todo hook do projeto
 * declara `apiClient.get<{ data: T }>(…)` e lê `.data`. Os hooks desta
 * integração nasceram declarando `apiClient.get<T>`, e o TypeScript aceitou:
 * o tipo é uma AFIRMAÇÃO sobre o corpo, não uma verificação dele.
 *
 * O resultado não foi erro nenhum. Foi `undefined` em todo campo:
 *
 *   - `conectado` virou `undefined` → a tela de configuração dizia "não
 *     conectado" com a integração gravada no banco e respondendo certo na API;
 *   - pelo mesmo motivo o botão **Cadastrar** nunca apareceu no cabeçalho da
 *     conversa — ele só existe quando a integração está ligada;
 *   - `webhook_secret` virou `undefined` → o segredo, que só aparece no
 *     instante em que é gerado, voltava do servidor e não tinha onde aparecer.
 *
 * Medido em 23/09, com a integração real ligada contra o Despacho Certo. O
 * servidor estava provado por chamadas diretas; a TELA nunca tinha sido
 * exercitada, e é exatamente aí que o envelope se perde.
 *
 * ─── Como a cerca prende ─────────────────────────────────────────────────────
 *
 * O fixture atravessa o `ok()` REAL — o mesmo wrapper que a rota chama no
 * `return` — e depois o hook REAL. Quem voltar a declarar o tipo sem envelope
 * cai aqui: o campo chega `undefined` e a asserção falha dizendo isso.
 *
 * Varrer os arquivos por texto compararia nomes; isto exercita o caminho.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSpy = vi.fn(async (_url: string): Promise<unknown> => ({ data: {} }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (url: string) => getSpy(url) },
}));

import { ok } from "@/lib/api/wrappers";
import { useDespachoCerto, useVinculoDoContato } from "@/hooks/integrations/useDespachoCerto";

/** O corpo EXATO do wire: `ok()` é o wrapper que a rota devolve. */
async function corpoDaRota(dados: unknown): Promise<unknown> {
  return (await ok(dados).json()) as unknown;
}

function novoWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("o hook do interruptor da integração", () => {
  it("lê `conectado` de dentro do envelope — é ele que faz o botão Cadastrar existir", async () => {
    getSpy.mockResolvedValueOnce(
      await corpoDaRota({
        conectado: true,
        status: "healthy",
        base_url: "https://dc.example.test",
        webhook_url: "https://crm.example.test/api/v1/webhooks/despachocerto/tok",
        tem_segredo: true,
      }),
    );

    const { result } = renderHook(() => useDespachoCerto(), { wrapper: novoWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(
      result.current.data?.conectado,
      "o hook entregou `undefined` — o envelope `{data:…}` não foi desembrulhado, " +
        "e com isso a tela diz 'não conectado' e o botão Cadastrar some da conversa",
    ).toBe(true);
  });

  it("entrega também a URL do webhook, que é o que o operador cola no outro sistema", async () => {
    getSpy.mockResolvedValueOnce(
      await corpoDaRota({
        conectado: true,
        webhook_url: "https://crm.example.test/api/v1/webhooks/despachocerto/tok",
        tem_segredo: true,
      }),
    );

    const { result } = renderHook(() => useDespachoCerto(), { wrapper: novoWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.webhook_url).toBe(
      "https://crm.example.test/api/v1/webhooks/despachocerto/tok",
    );
  });

  it("integração desligada continua sendo `conectado: false`, e não `undefined`", async () => {
    getSpy.mockResolvedValueOnce(await corpoDaRota({ conectado: false }));

    const { result } = renderHook(() => useDespachoCerto(), { wrapper: novoWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.conectado).toBe(false);
  });
});

describe("o hook do vínculo do contato", () => {
  it("lê `vinculado` de dentro do envelope", async () => {
    getSpy.mockResolvedValueOnce(
      await corpoDaRota({ vinculado: true, external_id: "cli-1", name: "Maria" }),
    );

    const { result } = renderHook(() => useVinculoDoContato("c-1", true), {
      wrapper: novoWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.vinculado).toBe(true);
    expect(result.current.data?.external_id).toBe("cli-1");
  });

  it("não pergunta nada enquanto a integração estiver desligada", async () => {
    renderHook(() => useVinculoDoContato("c-1", false), { wrapper: novoWrapper() });
    expect(getSpy).not.toHaveBeenCalled();
  });
});
