/**
 * A BARRA SUPERIOR É A NAVEGAÇÃO — o menu lateral não existe mais.
 *
 * ─── O que mudou (2026-09-10) ──────────────────────────────────────────────
 *
 * O menu lateral carregava 20 links em seis grupos e ocupava 240px de toda
 * tela. O produto é a conversa, e em 1280px sobravam 1040 para o inbox de três
 * colunas. Saiu. No lugar:
 *
 *   - as ABAS na barra superior (`AbasPrincipais`): cinco, de uso diário;
 *   - a ENGRENAGEM ao lado da busca, que leva ao inventário (`TopBar`);
 *   - a GAVETA do celular (`MenuCompleto`), com o inventário em lista.
 *
 * ─── O que estes testes protegem ──────────────────────────────────────────
 *
 *  - as abas saem do registro, na ordem declarada, e marcam a rota atual;
 *  - o que não é aba NÃO está na barra (senão o menu lateral volta, deitado);
 *  - a gaveta não deixa cabeçalho órfão quando a permissão esvazia o grupo;
 *  - Configurações fica no rodapé da gaveta, fora da área que rola;
 *  - Etapas do funil (que mora em `/app/settings/…` mas é CRM) acende sozinha,
 *    sem acender Configurações junto.
 *
 * A regra de quem-vê-o-quê é do registro e está coberta em
 * `navegacao-registry.test.ts`; aqui é a superfície.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AbasPrincipais } from "@/components/shell/AbasPrincipais";
import { MenuCompleto } from "@/components/shell/MenuCompleto";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: null,
};
let pathname = "/app/inbox";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => authRef,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));

function comoPapel(role: ActiveOrg["role"]) {
  authRef.user = { is_platform_admin: false };
  authRef.activeOrg = { orgId: "org-1", name: "Org", role };
}

afterEach(() => {
  cleanup();
  pathname = "/app/inbox";
});

describe("as abas da barra superior", () => {
  it("são as cinco de quem atende, na ordem decidida", () => {
    comoPapel("agent");
    render(<AbasPrincipais />);
    const nomes = screen.getAllByRole("link").map((el) => el.getAttribute("title"));
    expect(nomes).toEqual(["Inbox", "Contatos", "Funis", "Agenda", "IA"]);
  });

  it("gestor e administrador ganham a sexta, Relatórios, por último", () => {
    for (const papel of ["manager", "admin"] as const) {
      comoPapel(papel);
      const { unmount } = render(<AbasPrincipais />);
      const nomes = screen.getAllByRole("link").map((el) => el.getAttribute("title"));
      expect(nomes, papel).toEqual(["Inbox", "Contatos", "Funis", "Agenda", "IA", "Relatórios"]);
      unmount();
    }
  });

  it("estão dentro de uma <nav> chamada Navegação principal", () => {
    comoPapel("admin");
    render(<AbasPrincipais />);
    expect(screen.getByRole("navigation", { name: "Navegação principal" })).toBeTruthy();
  });

  it("o que não é aba NÃO está na barra", () => {
    // Uma sexta aba é a volta do menu lateral, deitado. Etapas do funil e
    // Webhooks são do inventário.
    comoPapel("admin");
    render(<AbasPrincipais />);
    expect(screen.queryByRole("link", { name: /Etapas do funil/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Webhooks/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Configurações/ })).toBeNull();
  });

  it("marca a rota atual com aria-current, e só ela", () => {
    comoPapel("admin");
    pathname = "/app/kanban/abc";
    render(<AbasPrincipais />);
    expect(screen.getByRole("link", { name: "Funis" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Inbox" })).not.toHaveAttribute("aria-current");
  });

  it("a aba de IA abre o hub", () => {
    comoPapel("admin");
    render(<AbasPrincipais />);
    expect(screen.getByRole("link", { name: "IA" })).toHaveAttribute("href", "/app/ai");
  });
});

describe("a gaveta do celular (MenuCompleto)", () => {
  it("renderiza os grupos na ordem de uso, sem Organização", () => {
    // Organização não tem título aqui: seu hub (Configurações) vive no rodapé
    // fixo, fora da área que rola.
    comoPapel("admin");
    render(<MenuCompleto />);
    const titulos = screen
      .getAllByRole("heading")
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    expect(titulos).toEqual(["Atendimento", "CRM", "Agente de IA", "Canais", "Análise"]);
  });

  it("carrega o inventário inteiro — inclusive o que só o hub de IA mostrava", () => {
    comoPapel("admin");
    render(<MenuCompleto />);
    expect(screen.getByRole("link", { name: "Etapas do funil" })).toHaveAttribute(
      "href",
      "/app/settings/tenant/pipelines",
    );
    expect(screen.getByRole("link", { name: /Conhecimento/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Nuvemshop/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Audit Log/ })).toBeTruthy();
  });

  it("Configurações fica no rodapé, fora da área que rola", () => {
    comoPapel("admin");
    render(<MenuCompleto />);
    const config = screen.getByRole("link", { name: /Configurações/ });
    expect(config).toHaveAttribute("href", "/app/settings");
    const nav = screen.getByRole("navigation", { name: "Todas as telas" });
    expect(nav.contains(config)).toBe(false);
  });

  it("não deixa cabeçalho órfão quando a permissão esvazia o grupo", () => {
    // CANAIS é todo manager+/admin. Um agent não pode ver o título sozinho.
    comoPapel("agent");
    render(<MenuCompleto />);
    const titulos = screen.getAllByRole("heading").map((el) => el.textContent?.trim());
    expect(titulos).not.toContain("Canais");
    expect(titulos).toContain("Atendimento");
  });

  it("em Etapas do funil, é ELA que acende — não Configurações junto", () => {
    // A tela mora em `/app/settings/tenant/pipelines`, e um `startsWith`
    // ingênuo em `/app/settings` acenderia Configurações também: dois itens
    // acesos para uma tela só.
    comoPapel("admin");
    pathname = "/app/settings/tenant/pipelines";
    render(<MenuCompleto />);
    expect(screen.getByRole("link", { name: "Etapas do funil" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: /Configurações/ })).not.toHaveAttribute("aria-current");
  });

  it("em Perfil, Configurações acende — a tela é do grupo que ela representa", () => {
    comoPapel("admin");
    pathname = "/app/settings/profile";
    render(<MenuCompleto />);
    expect(screen.getByRole("link", { name: /Configurações/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
