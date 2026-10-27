import type { Stage } from "./types";

/**
 * A cor de uma coluna do funil.
 *
 * Antes, toda etapa sem cor escolhida pelo operador era o mesmo ponto cinza — um quadro de seis
 * colunas idênticas, em que a ÚNICA diferença entre "acabou de chegar" e "quase fechando" era ler o
 * título. A cor passa a ser um segundo sinal (o título e a contagem continuam lá):
 *
 *   - **Etapa de ganho** → verde (`--color-success`), com um ícone de confirmação ao lado do nome.
 *   - **Etapa de perda** → vermelho (`--color-error`), com um ícone de proibido ao lado do nome.
 *   - **Etapas abertas, em ordem** → a rampa da marca, do tom claro ao escuro: quanto mais perto de
 *     fechar, mais forte a cor. É uma progressão, não um código — por isso usa a cor da marca e não o
 *     âmbar, que neste produto já quer dizer "atenção".
 *
 * A cor que o operador escolheu para a etapa SEMPRE vence: é dado dele, não padrão nosso.
 *
 * Os valores são `var(--…)`, então seguem o tema claro/escuro e a cor da marca da instalação sozinhos.
 * Os degraus 300–800 da rampa são os mesmos nos dois temas (ver `app/globals.css`).
 */

/** Do mais claro ao mais escuro: o tom da primeira etapa aberta e o da última. */
const DEGRAUS = [300, 400, 500, 600, 700, 800] as const;

export type EtapaParaCor = Pick<Stage, "color" | "is_won" | "is_lost">;

/**
 * @param posicaoEntreAbertas índice da etapa entre as ABERTAS (ganho e perda ficam de fora da conta)
 * @param totalAbertas quantas etapas abertas o funil tem
 */
export function corDaEtapa(etapa: EtapaParaCor, posicaoEntreAbertas: number, totalAbertas: number): string {
  const propria = etapa.color?.trim();
  if (propria) return propria;
  if (etapa.is_won) return "var(--color-success)";
  if (etapa.is_lost) return "var(--color-error)";

  const ultimo = DEGRAUS.length - 1;
  const t = totalAbertas <= 1 ? 0.5 : Math.min(Math.max(posicaoEntreAbertas, 0), totalAbertas - 1) / (totalAbertas - 1);
  const grau = DEGRAUS[Math.round(t * ultimo)] ?? DEGRAUS[ultimo];
  return `var(--color-accent-${grau})`;
}
