import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A FOTO É PEDIDA PELA IDENTIDADE QUE O WHATSAPP USA HOJE.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * O WhatsApp passou a endereçar parte dos contatos por um id opaco (`@lid`) em
 * vez do número. Para esses, perguntar a foto de perfil por `<numero>@c.us`
 * devolve `null` — e `null` é indistinguível de "esta pessoa não tem foto".
 *
 * Em 14/10, numa fila real, seis contatos apareciam com iniciais. Perguntados
 * ao transporte pelos DOIS endereços, no mesmo instante:
 *
 *     Markos França       @lid → URL      @c.us → null
 *     Carlos              @lid → URL      @c.us → null
 *     Larissa-Vendas      @lid → URL      @c.us → null
 *     Hallison Colonetti  @lid → URL      @c.us → null
 *     Eu                  @lid → URL      @c.us → null
 *     Rafaela Duarte      @lid → URL      @c.us → null
 *
 * Seis de seis. A foto estava disponível o tempo todo; a varredura perguntava
 * pelo endereço que o WhatsApp deixou de usar para aquelas pessoas.
 *
 * ─── Por que a ORDEM é a regra ──────────────────────────────────────────────
 *
 * `phone_number` continua preenchido para quem já tem `wa_lid`. Então qualquer
 * implementação que olhe o número primeiro — ou que só caia no `@lid` quando o
 * número falta — reproduz o defeito inteiro, sem ficar vermelha em lugar
 * nenhum. É por isso que esta cerca prende a PRECEDÊNCIA, e não a mera
 * existência do `@lid` no arquivo.
 *
 * O diagnóstico errado que isto também sepulta: por semanas a explicação foi
 * "privacidade do contato". Era falsa, e custou duas conversas.
 */

const ROTA = resolve(process.cwd(), "app/api/v1/cron/contact-avatars/route.ts");
const fonte = readFileSync(ROTA, "utf8");

/** O corpo da função que escolhe o endereço. */
function corpoDaEscolha(): string {
  const i = fonte.indexOf("function ondePerguntarAFoto");
  expect(
    i,
    "sumiu a função que escolhe onde perguntar a foto — sem ela a precedência " +
      "volta a ser implícita, e foi implícita que ela errou",
  ).toBeGreaterThan(-1);
  // `\n}\n` e não `\n}`: a assinatura tem um tipo literal inline, cujo `}`
  // fecharia o recorte antes do corpo — e a cerca passaria a medir a assinatura.
  const fim = fonte.indexOf("\n}\n", i);
  return fonte.slice(i, fim);
}

describe("onde a varredura pergunta a foto", () => {
  it("a identidade opaca vem ANTES do número", () => {
    const corpo = corpoDaEscolha();
    const posLid = corpo.indexOf("wa_lid");
    const posIdentidade = corpo.indexOf("wa_identity");
    expect(posLid).toBeGreaterThan(-1);
    expect(posIdentidade).toBeGreaterThan(-1);
    expect(
      posLid < posIdentidade,
      "o número voltou a ser consultado primeiro — e como ele continua " +
        "preenchido para quem já tem lid, a foto de todo contato migrado some " +
        "de novo, em silêncio",
    ).toBe(true);
  });

  it("o endereço opaco é montado com o sufixo que o transporte espera", () => {
    expect(/\$\{c\.wa_lid\}@lid/.test(corpoDaEscolha())).toBe(true);
  });

  it("a consulta traz o wa_lid — sem ele a escolha não tem o que preferir", () => {
    expect(fonte.includes("wa_lid, avatar_storage_path")).toBe(true);
  });

  it("quem tem só o lid também entra na varredura", () => {
    expect(
      fonte.includes('.or("wa_identity.not.is.null,wa_lid.not.is.null")'),
      "voltar a exigir `wa_identity` deixaria de fora o contato que só tem lid",
    ).toBe(true);
  });
});
