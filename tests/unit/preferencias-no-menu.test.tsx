import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PreferenciasNoMenu } from "@/components/shell/PreferenciasNoMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * IDIOMA E TEMA DENTRO DO MENU DO USUÁRIO — o destino deles abaixo de `lg`.
 *
 * Eles saíram da barra do celular porque a barra não os comportava (a direita chegou a 290 dos 351px
 * úteis; ver o orçamento no `TopBar` e a medida em `tests/e2e/barra-superior-nao-se-sobrepoe.spec.ts`).
 * Tirar um botão da tela só é conserto se a ação CONTINUA alcançável — e é isto que este arquivo prova:
 * o menu oferece os dois idiomas e os três temas, mostra o que está em vigor, e escolher chama a MESMA
 * troca que o botão da barra chama (`useTrocarDeIdioma`, `setTheme`) — não uma cópia que um dia diverge.
 *
 * Desde a coluna lateral (de `md` em diante) a seção aparece em toda largura — não há mais os botões
 * de idioma e tema soltos na barra.
 */

const escolher = vi.fn();
const setTheme = vi.fn();
let idioma: "pt-BR" | "es" = "pt-BR";
let tema: "light" | "dark" | "system" = "system";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ theme: tema, setTheme }) }));
// O hook de verdade chama uma server action e recarrega a página — nada disso cabe num teste de
// componente. O que importa aqui é QUE ele é o chamado, e com qual idioma.
vi.mock("@/components/shell/SeletorDeIdioma", () => ({
  NOME_DO_IDIOMA: {
    "pt-BR": { curto: "PT", completo: "Português (BR)" },
    es: { curto: "ES", completo: "Español" },
  },
  useTrocarDeIdioma: () => ({ idioma, escolher, salvando: false }),
}));

function abrirMenu() {
  return render(
    <DropdownMenu open>
      <DropdownMenuTrigger>menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <PreferenciasNoMenu />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  idioma = "pt-BR";
  tema = "system";
});

describe("idioma e tema no menu do usuário", () => {
  it("oferece os dois idiomas, na língua de cada um, e marca o que está em vigor", () => {
    abrirMenu();
    const pt = screen.getByTestId("menu-idioma-pt-BR");
    const es = screen.getByTestId("menu-idioma-es");
    expect(pt).toHaveTextContent("Português (BR)");
    expect(es).toHaveTextContent("Español");
    expect(pt).toHaveAttribute("aria-current", "true");
    expect(es).toHaveAttribute("aria-current", "false");
  });

  it("marca o idioma novo quando o em vigor é o espanhol", () => {
    idioma = "es";
    abrirMenu();
    expect(screen.getByTestId("menu-idioma-es")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("menu-idioma-pt-BR")).toHaveAttribute("aria-current", "false");
  });

  it("oferece os três temas e marca o em vigor", () => {
    tema = "dark";
    abrirMenu();
    expect(screen.getByTestId("menu-tema-light")).toHaveTextContent("Claro");
    expect(screen.getByTestId("menu-tema-dark")).toHaveTextContent("Escuro");
    expect(screen.getByTestId("menu-tema-system")).toHaveTextContent("Sistema");
    expect(screen.getByTestId("menu-tema-dark")).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("menu-tema-light")).toHaveAttribute("aria-current", "false");
  });

  it("escolher o tema chama o mesmo setTheme do botão da barra", () => {
    abrirMenu();
    fireEvent.click(screen.getByTestId("menu-tema-dark"));
    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("escolher o idioma chama a troca única, com o código escolhido", () => {
    abrirMenu();
    fireEvent.click(screen.getByTestId("menu-idioma-es"));
    expect(escolher).toHaveBeenCalledWith("es");
  });

  it("aparece em TODA largura: a coluna lateral (64px) não tem lugar para botões soltos", () => {
    // Antes era `lg:hidden` (de `lg` em diante os botões ficavam na barra). Com a navegação na
    // coluna lateral, idioma e tema só existem aqui — esconder a seção seria perder a ação.
    abrirMenu();
    const classes = screen.getByTestId("preferencias-no-menu").className.split(/\s+/);
    expect(classes.some((c) => c.endsWith(":hidden") || c === "hidden")).toBe(false);
  });
});
