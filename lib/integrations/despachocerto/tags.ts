/**
 * AS TAGS QUE A OS DEIXA NA CONVERSA E NO CONTATO.
 *
 * Formato escolhido pelo dono em 2026-09-22: `OS 1234` e `ABC1D23`.
 *
 * A OS leva prefixo porque um número solto não diz o que é — `1234` numa lista
 * de tags ao lado de "VIP" e "Orçamento" é ruído. A placa NÃO leva: a forma
 * dela já é reconhecível para quem trabalha com veículo, e `Placa ABC1D23`
 * gastaria metade da largura da tag repetindo o óbvio numa tela (o inbox) onde
 * a tag disputa espaço com nome e telefone.
 *
 * ─── Funções puras, de propósito ────────────────────────────────────────────
 *
 * Nada aqui toca banco nem rede. É o que permite provar o formato, a
 * normalização e a deduplicação sem subir nada — e é onde um bug de formato
 * apareceria primeiro, porque tag errada não dá erro: ela só cria uma segunda
 * tag quase igual, e a lista de marcadores da organização apodrece em silêncio.
 */

/** `OS 1234` — o número como a equipe do despachante o chama. */
export function tagDaOs(numero: string): string {
  return `OS ${numero.trim()}`;
}

/**
 * `ABC1D23` — placa sem hífen, sem espaço, em maiúsculas.
 *
 * A mesma placa chega escrita de três jeitos (`abc-1d23`, `ABC 1D23`,
 * `abc1d23`) conforme quem digitou. Sem normalizar, o contato acumularia três
 * tags para um veículo só.
 */
export function tagDaPlaca(placa: string): string {
  return placa.replace(/[\s-]/g, "").toUpperCase();
}

/** Uma placa é aproveitável? (vazio e lixo não viram tag.) */
export function ehPlacaUtil(placa: string | null | undefined): placa is string {
  const v = (placa ?? "").replace(/[\s-]/g, "");
  return v.length >= 6 && /^[A-Za-z0-9]+$/.test(v);
}

/**
 * As tags que um evento de OS produz: a da OS e a de cada placa dela.
 *
 * Devolve na ordem em que foram pedidas e sem repetidas — a placa principal
 * pode aparecer também na lista de adicionais, e o outro sistema não promete
 * que não vai.
 */
export function tagsDoEvento(entrada: {
  numero: string;
  placa?: string | null;
  placasAdicionais?: string[];
}): string[] {
  const tags = [tagDaOs(entrada.numero)];
  for (const p of [entrada.placa, ...(entrada.placasAdicionais ?? [])]) {
    if (ehPlacaUtil(p)) tags.push(tagDaPlaca(p));
  }
  return [...new Set(tags)];
}

/**
 * Junta as tags novas às que já existem, preservando a ordem e sem duplicar.
 *
 * A comparação é EXATA (não case-insensitive): as tags da organização são
 * escritas por gente, e transformar "vip" em "VIP" porque a integração passou
 * por ali seria a integração reescrevendo trabalho de outro. O que ela evita é
 * só a repetição do que ela mesma escreve, que já vem normalizado.
 */
export function juntarTags(existentes: string[] | null | undefined, novas: string[]): {
  todas: string[];
  acrescentadas: string[];
} {
  const atuais = existentes ?? [];
  const acrescentadas = novas.filter((t) => !atuais.includes(t));
  return { todas: acrescentadas.length === 0 ? atuais : [...atuais, ...acrescentadas], acrescentadas };
}
