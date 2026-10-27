/**
 * A cor do rosto de um contato que não tem foto.
 *
 * Uma lista de conversas com 50 círculos cinza e duas letras obriga a LER cada um para saber quem é
 * quem; com uma cor por pessoa o olho reconhece o contato antes de ler o nome — é o que o WhatsApp faz.
 * A cor é só um segundo sinal: as iniciais continuam lá, e o nome ao lado.
 *
 * ── De onde saem as cores ─────────────────────────────────────────────────────────────────────────
 * As oito "trilhas de pessoa" do design system (`--agenda-pessoa-1…8` em `app/globals.css`). Elas já
 * foram derivadas para serem distinguíveis entre si (distância OKLab medida, matizes espalhados,
 * luminosidade alternada), não dependem da cor da marca da instalação e têm versão clara e escura.
 * Inventar uma paleta de avatar à parte seria uma segunda escolha de oito cores para envelhecer
 * separada da primeira.
 *
 * ── Por que a escolha é pelo ID, e estável ────────────────────────────────────────────────────────
 * O mesmo contato tem a mesma cor em toda tela e em toda visita. Sai de um hash do identificador, não de
 * um sorteio nem da posição na lista — que mudaria a cor de quem sobe e desce na fila.
 */

/** Quantas trilhas de cor de pessoa existem no CSS (`--agenda-pessoa-1…8`). */
export const TRILHAS_DE_PESSOA = 8;

/**
 * FNV-1a de 32 bits. Pequeno, sem dependência e bem espalhado para strings curtas (uuid, telefone, nome).
 * Não é criptografia: a única propriedade pedida é distribuição uniforme e determinismo.
 */
function fnv1a(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i += 1) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * O número da trilha (1…8) de um contato, ou `null` quando não há de onde tirar uma cor (sem
 * identificador nenhum) — e aí o rosto fica no cinza neutro, que é a resposta honesta.
 */
export function trilhaDoAvatar(semente: string | null | undefined): number | null {
  const s = (semente ?? "").trim();
  if (s === "") return null;
  return (fnv1a(s) % TRILHAS_DE_PESSOA) + 1;
}

/**
 * Os dois estilos do rosto: fundo (22% da trilha sobre a superfície) e iniciais (60% da trilha
 * escurecida pelo texto do tema). A razão mínima de contraste das iniciais é 4,86 no claro e 6,62 no
 * escuro nas oito trilhas — conferida por fora do código (WCAG) quando as proporções foram escolhidas.
 */
export function estiloDoAvatar(trilha: number | null): { backgroundColor: string; color: string } | undefined {
  if (trilha === null) return undefined;
  const cor = `var(--agenda-pessoa-${trilha})`;
  return {
    backgroundColor: `color-mix(in srgb, ${cor} 22%, var(--color-surface))`,
    color: `color-mix(in srgb, ${cor} 60%, var(--color-text))`,
  };
}
