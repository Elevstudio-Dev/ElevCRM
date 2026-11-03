/**
 * Os participantes de um grupo, como o WAHA os entrega — normalizados.
 *
 * A forma varia entre as versões e os engines, e foi medida em outro lugar deste mesmo cliente
 * (`listGroups`) que a diferença vira bug de tela quando não é absorvida num ponto só:
 *
 *   - `participants/v2` (a forma recomendada pela documentação): `[{ id, role }]`, com `role` em
 *     `left | participant | admin | superadmin`;
 *   - o objeto do grupo (`GET …/groups/{id}`): `participants` com `{ id, admin }`, em que `admin` é
 *     `null | "admin" | "superadmin"` (NOWEB) ou um booleano `isAdmin` (WEBJS);
 *   - o `id` é uma string (`5511…@c.us`, `1234…@lid`) ou `{ _serialized }`;
 *   - nas versões recentes vem também o telefone de quem usa `@lid`, em `pn` ou `phoneNumber`.
 *
 * Quem tem `role: "left"` já saiu do grupo e não é marcável.
 */

export interface ParticipanteCru {
  /** O endereço como veio (`@c.us`, `@lid` ou `@s.whatsapp.net`). */
  id: string;
  /** O telefone (só dígitos), quando o WAHA o disse. */
  pn: string | null;
  admin: boolean;
}

function textoDe(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { _serialized?: unknown })._serialized === "string") {
    return (v as { _serialized: string })._serialized;
  }
  return null;
}

/** Só os dígitos de `5511999990001@s.whatsapp.net`, de `+55 11…` ou de `5511999990001`. `null` se não sobrar nada. */
function digitosDoTelefone(v: unknown): string | null {
  const t = textoDe(v);
  if (!t) return null;
  const d = (t.split("@")[0] ?? "").replace(/\D/g, "");
  return d.length >= 5 ? d : null;
}

function ehAdmin(p: Record<string, unknown>): boolean {
  const papel = typeof p.role === "string" ? p.role : typeof p.admin === "string" ? p.admin : null;
  if (papel === "admin" || papel === "superadmin") return true;
  return p.admin === true || p.isAdmin === true || p.isSuperAdmin === true;
}

export function normalizarParticipantes(cru: unknown): ParticipanteCru[] {
  const itens: unknown[] = Array.isArray(cru)
    ? cru
    : cru && typeof cru === "object"
      ? Object.values(cru as Record<string, unknown>)
      : [];
  const saida: ParticipanteCru[] = [];
  const vistos = new Set<string>();
  for (const item of itens) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (p.role === "left") continue;
    const id = textoDe(p.id);
    // Sem endereço de pessoa não há quem marcar — e `@g.us` é o grupo, não um participante.
    if (!id || !/@(c\.us|lid|s\.whatsapp\.net)$/.test(id)) continue;
    if (vistos.has(id)) continue;
    vistos.add(id);
    saida.push({ id, pn: digitosDoTelefone(p.pn ?? p.phoneNumber), admin: ehAdmin(p) });
  }
  return saida;
}

/**
 * O telefone a mostrar: o que o WAHA disse (`pn`) ou, para quem tem número no endereço, o próprio
 * endereço. Para `@lid` sem `pn` é `null` — o número do `@lid` NÃO é telefone.
 */
export function telefoneDoParticipante(p: ParticipanteCru): string | null {
  if (p.pn) return p.pn;
  if (/@(c\.us|s\.whatsapp\.net)$/.test(p.id)) return digitosDoTelefone(p.id);
  return null;
}
