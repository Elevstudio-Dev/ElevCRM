import { render, screen } from "@testing-library/react";
import { ptBR } from "date-fns/locale";
import { describe, expect, it } from "vitest";

import { AnuncioDoContato } from "@/components/inbox/AnuncioDoContato";
import type { AnuncioDoContato as Anuncio } from "@/lib/leads/anuncio-do-contato";

const base: Anuncio = {
  plataforma: "meta_ads",
  app: "Instagram",
  titulo: "Tire suas dúvidas sobre clareamento",
  texto: "Agende sua avaliação",
  url: "https://www.instagram.com/p/abc/",
  anuncioId: "120210000000000",
  clicadoEm: "2026-11-09T15:35:00.000Z",
};

describe("AnuncioDoContato (painel da conversa)", () => {
  it("mostra título, texto, app e o link do anúncio abrindo em outra aba, sem repassar o referrer", () => {
    render(<AnuncioDoContato anuncio={base} locale={ptBR} />);
    expect(screen.getByText("Tire suas dúvidas sobre clareamento")).toBeTruthy();
    expect(screen.getByText("Agende sua avaliação")).toBeTruthy();
    expect(screen.getByText("Instagram")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Ver anúncio/ });
    expect(link.getAttribute("href")).toBe("https://www.instagram.com/p/abc/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("sem título, link e app: diz 'Anúncio sem título' e não desenha botão nem selo vazios", () => {
    render(
      <AnuncioDoContato
        anuncio={{ ...base, titulo: null, texto: null, url: null, app: null, clicadoEm: null }}
        locale={ptBR}
      />,
    );
    expect(screen.getByText("Anúncio sem título")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Instagram")).toBeNull();
  });

  it("o texto do anunciante entra como TEXTO, nunca como HTML", () => {
    const { container } = render(
      <AnuncioDoContato anuncio={{ ...base, texto: "<img src=x onerror=alert(1)>" }} locale={ptBR} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });
});
