import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { TopBar } from "@/components/shell/TopBar";

/**
 * A MARCA CEDE AO SELETOR DE ORGANIZAÇÃO — a decisão da barra, provada.
 *
 * Com mais de uma organização o seletor aparece, e no celular a barra não comporta a marca
 * (selo + nome) AO LADO dele: medido em 375px, o seletor sobrava 109px e a marca o empurrava por cima
 * de Buscar, Chat e Avisos. A saída é a marca ceder a largura inteira ao seletor — `max-md:hidden`,
 * passado pelo `TopBar` — porque saber em qual organização se está importa mais que o selo.
 * (Era `max-xl:hidden` quando a barra ficava no topo também no desktop; a coluna lateral de `md`
 * em diante empilha os dois e não precisa mais ceder.)
 *
 * Sem seletor a marca NÃO cede: o selo da Elev fica sempre (1.19.0), e é por isso que a classe só
 * pode ir quando o seletor existe. As larguras de verdade, no navegador, são da spec e2e
 * `barra-superior-nao-se-sobrepoe`; jsdom não mede layout, então aqui se prova a DECISÃO.
 */

let temSeletor = false;

vi.mock("@/components/connections/ConnectionHealthDot", () => ({ ConnectionHealthDot: () => null }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { is_platform_admin: false },
    activeOrg: { orgId: "org-1", name: "Org", role: "admin" },
  }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/inbox" }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/components/chat-interno/BotaoDoChat", () => ({ BotaoDoChat: () => null }));
vi.mock("@/components/shell/AbasPrincipais", () => ({ AbasPrincipais: () => null }));
vi.mock("@/components/shell/AlertsBell", () => ({ AlertsBell: () => null }));
vi.mock("@/components/shell/MenuMobile", () => ({ MenuMobile: () => null }));
vi.mock("@/components/shell/SearchTrigger", () => ({ SearchTrigger: () => null }));
vi.mock("@/components/shell/UserMenu", () => ({ UserMenu: () => null }));
vi.mock("@/components/shell/MarcaNaBarra", () => ({
  MarcaNaBarra: ({ className }: { className?: string }) => <a data-testid="marca" className={className ?? ""} />,
}));
vi.mock("@/components/shell/TenantSwitcher", () => ({
  TenantSwitcher: () => null,
  useTemSeletorDeOrganizacao: () => temSeletor,
}));

afterEach(() => {
  cleanup();
  temSeletor = false;
});

describe("a marca na barra superior", () => {
  it("COM seletor de organização cede a largura a ele no celular (abaixo de md)", () => {
    // De `md` em diante a casca é a coluna lateral de 64px, e ali cabem a marca E o seletor, um
    // embaixo do outro — por isso a marca só cede onde a barra é uma linha só.
    temSeletor = true;
    render(<TopBar />);
    const classes = screen.getByTestId("marca").className.split(/\s+/);
    expect(classes).toContain("max-md:hidden");
    expect(classes).not.toContain("max-xl:hidden");
  });

  it("SEM seletor não cede nunca: o selo fica sempre", () => {
    temSeletor = false;
    render(<TopBar />);
    expect(screen.getByTestId("marca").className).not.toContain("hidden");
  });

  it("o grupo da direita é empurrado para a borda pela margem, não por um vão vazio que come largura", () => {
    // O `<div class="flex-1">` vazio custava 8px de `gap` de cada lado, no celular, para nada.
    render(<TopBar />);
    const barra = screen.getByRole("banner");
    expect(barra.querySelector(".ml-auto")).not.toBeNull();
    expect(barra.querySelector(".flex-1")).toBeNull();
  });
});
