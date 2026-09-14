import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAVE_RECARREGOU,
  INTERVALO_MINIMO_MS,
  ehErroDeCarregamento,
  recarregarUmaVez,
} from "@/lib/feedback/erro-de-carregamento";

/**
 * "O SISTEMA FOI ATUALIZADO COM A ABA ABERTA" TEM CARA PRÓPRIA — E SAÍDA PRÓPRIA.
 *
 * Medido em 2026-09-14: o servidor de teste foi rebuildado com a aba do dono
 * aberta; o próximo clique caiu em "Algo deu errado" com um ID de Sentry que,
 * numa instalação sem Sentry, não leva a ninguém a lugar nenhum — e "Tentar de
 * novo" não resolvia, porque a lista de pedaços antiga continuava na aba.
 *
 * Três coisas ficam provadas aqui:
 *   1. o reconhecimento pelo nome/mensagem do erro (webpack e ESM);
 *   2. o recarregamento automático acontece UMA vez por minuto, nunca em laço;
 *   3. a tela de erro genérica passa a mostrar a mensagem do erro, porque o ID
 *      sozinho não diz nada a quem não tem Sentry ligado.
 */

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(() => "evento-falso") }));

afterEach(() => {
  // `clearAllMocks`, não `restoreAllMocks`: o `captureException` é um `vi.fn`
  // de módulo, e o que precisa zerar entre casos é o HISTÓRICO de chamadas.
  vi.clearAllMocks();
});

describe("ehErroDeCarregamento", () => {
  it("reconhece o ChunkLoadError do webpack e o import dinâmico falho do ESM", () => {
    expect(ehErroDeCarregamento({ name: "ChunkLoadError", message: "Loading chunk 4821 failed." })).toBe(true);
    expect(ehErroDeCarregamento({ message: "Failed to fetch dynamically imported module: /_next/x.js" })).toBe(true);
    expect(ehErroDeCarregamento({ message: "error loading dynamically imported module" })).toBe(true);
    expect(ehErroDeCarregamento({ message: "Importing a module script failed." })).toBe(true);
  });

  it("não confunde com erro comum, nem com nada", () => {
    expect(ehErroDeCarregamento({ name: "TypeError", message: "Cannot read properties of undefined" })).toBe(false);
    expect(ehErroDeCarregamento(new Error("An error occurred in the Server Components render."))).toBe(false);
    expect(ehErroDeCarregamento(null)).toBe(false);
    expect(ehErroDeCarregamento({})).toBe(false);
  });
});

describe("recarregarUmaVez", () => {
  function armazenamento(inicial: Record<string, string> = {}) {
    const dados = { ...inicial };
    return {
      dados,
      getItem: (k: string) => dados[k] ?? null,
      setItem: (k: string, v: string) => {
        dados[k] = v;
      },
    };
  }

  it("na primeira vez marca a hora e recarrega", () => {
    const st = armazenamento();
    const recarregar = vi.fn();
    expect(recarregarUmaVez(st, recarregar, 1_000_000)).toBe(true);
    expect(recarregar).toHaveBeenCalledTimes(1);
    expect(st.dados[CHAVE_RECARREGOU]).toBe("1000000");
  });

  it("logo depois de um recarregamento NÃO recarrega de novo — isso seria laço", () => {
    const st = armazenamento({ [CHAVE_RECARREGOU]: "1000000" });
    const recarregar = vi.fn();
    expect(recarregarUmaVez(st, recarregar, 1_000_000 + INTERVALO_MINIMO_MS - 1)).toBe(false);
    expect(recarregar).not.toHaveBeenCalled();
  });

  it("passado o intervalo, a mesma aba se recupera sozinha da próxima atualização", () => {
    const st = armazenamento({ [CHAVE_RECARREGOU]: "1000000" });
    const recarregar = vi.fn();
    expect(recarregarUmaVez(st, recarregar, 1_000_000 + INTERVALO_MINIMO_MS)).toBe(true);
    expect(recarregar).toHaveBeenCalledTimes(1);
  });

  it("sem armazenamento (janela privada bloqueada) não recarrega sozinho — a tela ainda serve", () => {
    const recarregar = vi.fn();
    expect(recarregarUmaVez(null, recarregar)).toBe(false);
    expect(recarregar).not.toHaveBeenCalled();
  });
});

describe("SegmentError", () => {
  it("em erro comum mostra o ID E a mensagem do erro", async () => {
    const { SegmentError } = await import("@/components/feedback/SegmentError");
    render(<SegmentError error={new Error("Cannot read properties of undefined (reading 'nome')")} reset={() => {}} />);
    expect(screen.getByText("Algo deu errado")).toBeInTheDocument();
    expect(await screen.findByText(/ID: evento-falso/)).toBeInTheDocument();
    expect(screen.getByTestId("erro-mensagem")).toHaveTextContent("Cannot read properties of undefined");
  });

  it("em aba desatualizada explica, oferece Recarregar e não manda o erro ao Sentry", async () => {
    const sentry = await import("@sentry/nextjs");
    const { SegmentError } = await import("@/components/feedback/SegmentError");
    // Já recarregou há 5 s: o automático não dispara, e a tela é que aparece.
    window.sessionStorage.setItem(CHAVE_RECARREGOU, String(Date.now() - 5_000));
    const erro = Object.assign(new Error("Loading chunk 123 failed."), { name: "ChunkLoadError" });
    render(<SegmentError error={erro} reset={() => {}} />);
    expect(screen.getByTestId("erro-aba-desatualizada")).toBeInTheDocument();
    expect(screen.getByText("O sistema foi atualizado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recarregar" })).toBeInTheDocument();
    expect(screen.queryByText("Algo deu errado")).toBeNull();
    expect(sentry.captureException).not.toHaveBeenCalled();
    window.sessionStorage.removeItem(CHAVE_RECARREGOU);
  });
});
