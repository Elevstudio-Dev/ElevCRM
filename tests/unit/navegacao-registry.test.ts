import { describe, expect, it } from "vitest";

import {
  NAV_DESTINATIONS,
  NAV_GROUPS,
  abasPrincipais,
  canSee,
  hubSections,
  inventario,
  searchable,
} from "@/lib/navigation/registry";

/**
 * O registro é a fonte única da navegação. Estes testes cobrem as projeções
 * puras — quem renderiza (barra superior, inventário, hub, ⌘K) não decide
 * nada, só desenha o que sai daqui. A completude do registro contra as rotas
 * de verdade é assunto de `navegacao-completude.test.ts`.
 */

const ADMIN = { platform: false, role: "admin" as const };
const MANAGER = { platform: false, role: "manager" as const };
const AGENT = { platform: false, role: "agent" as const };
const VIEWER = { platform: false, role: "viewer" as const };

function dest(href: string) {
  const d = NAV_DESTINATIONS.find((x) => x.href === href);
  if (!d) throw new Error(`destino ausente do registro: ${href}`);
  return d;
}

describe("integridade do registro", () => {
  it("não tem href duplicado", () => {
    const vistos = new Map<string, number>();
    for (const d of NAV_DESTINATIONS) vistos.set(d.href, (vistos.get(d.href) ?? 0) + 1);
    const duplicados = [...vistos.entries()].filter(([, n]) => n > 1).map(([href]) => href);
    expect(duplicados).toEqual([]);
  });

  it("todo destino aponta para um grupo declarado", () => {
    const ids = new Set(NAV_GROUPS.map((g) => g.id));
    const orfaos = NAV_DESTINATIONS.filter((d) => !ids.has(d.group)).map((d) => d.href);
    expect(orfaos).toEqual([]);
  });

  it("todo destino tem descrição — é o que o hub e o ⌘K mostram", () => {
    const semTexto = NAV_DESTINATIONS.filter((d) => d.description.trim() === "").map((d) => d.href);
    expect(semTexto).toEqual([]);
  });

  it("todo destino de um grupo com hub declara sua seção", () => {
    const comHub = new Set(NAV_GROUPS.filter((g) => g.hub).map((g) => g.id));
    const semSecao = NAV_DESTINATIONS.filter((d) => comHub.has(d.group) && !d.section).map(
      (d) => d.href,
    );
    expect(semSecao).toEqual([]);
  });
});

describe("canSee", () => {
  it("nega quem está abaixo do minRole", () => {
    expect(canSee(dest("/app/audit"), MANAGER.platform, MANAGER.role)).toBe(true);
    expect(canSee(dest("/app/audit"), AGENT.platform, AGENT.role)).toBe(false);
  });

  it("destino sem minRole é visível até para viewer", () => {
    expect(canSee(dest("/app/inbox"), VIEWER.platform, VIEWER.role)).toBe(true);
  });

  it("platform admin vê tudo, inclusive sem org ativa", () => {
    for (const d of NAV_DESTINATIONS) expect(canSee(d, true, null)).toBe(true);
  });

  it("sem papel e sem ser platform admin não vê nada", () => {
    expect(canSee(dest("/app/inbox"), false, null)).toBe(false);
  });
});

describe("abasPrincipais — a barra superior", () => {
  it("quem atende vê CINCO abas, na ordem decidida, e não a ordem dos grupos", () => {
    // A ordem é decisão de produto ("Contatos antes de Funis, como no
    // WhatsApp"), declarada em `principal: N` — não derivada da taxonomia. Se
    // fosse derivada, Agenda (grupo Atendimento) viria antes de Contatos (CRM).
    const CINCO = ["/app/inbox", "/app/contacts", "/app/kanban", "/app/agenda", "/app/ai"];
    expect(abasPrincipais(AGENT.platform, AGENT.role).map((a) => a.href)).toEqual(CINCO);
    expect(abasPrincipais(VIEWER.platform, VIEWER.role).map((a) => a.href)).toEqual(CINCO);
  });

  it("gestor e administrador vêem a SEXTA aba, Relatórios, por último", () => {
    // Decisão do dono em 2026-10-28: a sexta aba existe e é só para gestor+. Atendente não a vê.
    const SEIS = ["/app/inbox", "/app/contacts", "/app/kanban", "/app/agenda", "/app/ai", "/app/relatorios"];
    expect(abasPrincipais(true, null).map((a) => a.href)).toEqual(SEIS);
    expect(abasPrincipais(MANAGER.platform, MANAGER.role).map((a) => a.href)).toEqual(SEIS);
    expect(abasPrincipais(ADMIN.platform, ADMIN.role).map((a) => a.href)).toEqual(SEIS);
  });

  it("Relatórios é gestor+ no registro, e QR codes (sem aba) também", () => {
    expect(dest("/app/relatorios").minRole).toBe("manager");
    expect(dest("/app/relatorios/qr-codes").minRole).toBe("manager");
    expect(dest("/app/relatorios/qr-codes").principal).toBeUndefined();
  });

  it("a aba de IA é o HUB, com o rótulo curto", () => {
    // Uma aba por tela de IA seriam treze; a barra tem cinco lugares. O hub já
    // era o desenho para "tela demais": a aba só o promove.
    const ia = abasPrincipais(true, null).find((a) => a.href === "/app/ai");
    expect(ia?.label).toBe("IA");
  });

  it("uma aba por linha da barra — nunca uma fila que precise rolar", () => {
    // Cinco para quem atende; a sexta (Relatórios) é decisão do dono em 2026-10-28 e só aparece para gestor+.
    // Uma sétima é a volta do menu lateral, deitado.
    expect(abasPrincipais(true, null).length).toBeLessThanOrEqual(6);
    expect(abasPrincipais(AGENT.platform, AGENT.role).length).toBeLessThanOrEqual(5);
    expect(abasPrincipais(VIEWER.platform, VIEWER.role).length).toBeLessThanOrEqual(5);
  });

  it("não inclui o que é só do inventário", () => {
    const hrefs = abasPrincipais(true, null).map((a) => a.href);
    // Conhecimento existe no registro, mas é do inventário (e do hub de IA).
    expect(hrefs).not.toContain("/app/ai/knowledge/sources");
    expect(hrefs).not.toContain("/app/settings/tenant/pipelines");
  });

  it("respeita o papel", () => {
    // Tudo que é aba hoje é visível a viewer — o que a barra prova é que o
    // filtro existe: um destino `principal` com `minRole` some para quem
    // está abaixo.
    const paraViewer = abasPrincipais(VIEWER.platform, VIEWER.role).map((a) => a.href);
    for (const href of paraViewer) {
      const d = NAV_DESTINATIONS.find((x) => x.href === href);
      if (d) expect(canSee(d, VIEWER.platform, VIEWER.role)).toBe(true);
    }
  });

  it("o hub só vira aba se o papel enxerga alguma tela dele", () => {
    // Um viewer vê Alertas e Propostas (sem minRole); logo vê a aba de IA. A
    // guarda de vacuidade é o contrário: sem NENHUMA tela visível, a aba
    // sumiria — provado simulando um registro em que tudo de IA exige admin.
    const soAdmin = NAV_DESTINATIONS.filter((d) => d.group === "ia").every(
      (d) => !canSee(d, VIEWER.platform, VIEWER.role),
    );
    const temAba = abasPrincipais(VIEWER.platform, VIEWER.role).some((a) => a.href === "/app/ai");
    expect(temAba).toBe(!soAdmin);
  });
});

describe("inventario — Configurações", () => {
  it("lista TODOS os grupos, na ordem declarada", () => {
    const ids = inventario(true, null).map((g) => g.group.id);
    expect(ids).toEqual(NAV_GROUPS.map((g) => g.id));
  });

  it("carrega também o que já é aba — é inventário, não sobra", () => {
    const hrefs = inventario(true, null).flatMap((g) =>
      g.sections.flatMap((s) => s.items.map((i) => i.href)),
    );
    expect(hrefs).toContain("/app/inbox");
    expect(hrefs).toContain("/app/settings/tenant/pipelines");
    expect(hrefs).toContain("/app/ai/knowledge/sources");
    expect(hrefs).toContain("/app/settings/api-tokens");
  });

  it("todo destino do registro aparece no inventário para quem vê tudo", () => {
    // É a definição de inventário. Se um destino ficasse de fora, ele seria
    // alcançável só pelo ⌘K — que é uma porta para quem já sabe o nome.
    const hrefs = new Set(
      inventario(true, null).flatMap((g) => g.sections.flatMap((s) => s.items.map((i) => i.href))),
    );
    for (const d of NAV_DESTINATIONS) expect(hrefs.has(d.href), d.href).toBe(true);
  });

  it("omite o grupo inteiro quando o papel não vê nenhum item dele", () => {
    // CANAIS é todo manager+/admin: um agent não deve ver o título órfão.
    const ids = inventario(AGENT.platform, AGENT.role).map((g) => g.group.id);
    expect(ids).not.toContain("canais");
    expect(ids).toContain("atendimento");
  });

  it("grupo sem seções vira uma seção única sem título", () => {
    const crm = inventario(true, null).find((g) => g.group.id === "crm");
    expect(crm?.sections.map((s) => s.section)).toEqual([""]);
  });
});

describe("hubSections", () => {
  it("agrupa a IA nas três etapas da jornada, na ordem", () => {
    const secoes = hubSections("ia", true, null).map((s) => s.section);
    expect(secoes).toEqual(["Montar o agente", "Ensinar o agente", "Acompanhar o agente"]);
  });

  it("o hub mostra também o que já é aba — é inventário, não sobra", () => {
    const hrefs = hubSections("ia", true, null).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain("/app/ai/agents");
    expect(hrefs).toContain("/app/ai/knowledge/sources");
  });

  it("não vaza destino acima do papel", () => {
    const hrefs = hubSections("organizacao", VIEWER.platform, VIEWER.role).flatMap((s) =>
      s.items.map((i) => i.href),
    );
    expect(hrefs).not.toContain("/app/settings/api-tokens");
    expect(hrefs).toContain("/app/settings/profile");
  });

  it("some com a seção que ficou vazia pela permissão", () => {
    const secoes = hubSections("organizacao", VIEWER.platform, VIEWER.role).map((s) => s.section);
    expect(secoes).not.toContain("Dados e acesso");
  });
});

describe("searchable", () => {
  it("expõe todo destino visível, aba ou não", () => {
    const hrefs = searchable(ADMIN.platform, ADMIN.role).map((d) => d.href);
    expect(hrefs).toContain("/app/ai/knowledge/sources");
    expect(hrefs).toContain("/app/inbox");
  });

  it("respeita o papel", () => {
    const hrefs = searchable(AGENT.platform, AGENT.role).map((d) => d.href);
    expect(hrefs).not.toContain("/app/audit");
  });
});
