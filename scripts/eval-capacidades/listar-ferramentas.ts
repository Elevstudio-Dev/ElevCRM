/**
 * Lista as capacidades REAIS que um agente pode receber (nome, risco, pacote, início da descrição).
 * Só lê o catálogo do código — sem banco, sem rede, sem chave.
 *
 * Run: pnpm exec tsx scripts/eval-capacidades/listar-ferramentas.ts
 */
import { allTools } from "@/lib/mcp/tools";
import { catalogEntry } from "@/lib/mcp/tools/catalog";
import { BLOCKED_TOOL_IDS } from "@/lib/agent-engine/edge/crm/mcp-tools";

let n = 0;
for (const t of allTools) {
  const e = catalogEntry(t.name);
  const fora = BLOCKED_TOOL_IDS.has(t.name) ? "BLOQUEADA" : e?.apenasHumano ? "SÓ-HUMANO" : "ok";
  n += 1;
  console.log(
    [String(n).padStart(2), fora.padEnd(9), (e?.risco ?? "?").padEnd(8), (e?.pacotes ?? []).join("+").padEnd(22), t.name.padEnd(34), t.description.replace(/\s+/g, " ").slice(0, 110)].join(" | "),
  );
}
