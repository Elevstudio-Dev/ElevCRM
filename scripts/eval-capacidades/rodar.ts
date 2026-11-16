/**
 * Mede quantas capacidades um agente aguenta ligadas antes de começar a errar a escolha da ferramenta.
 *
 * ## O experimento
 *
 * Para cada cenário (`cenarios.ts`) e cada tamanho N, o modelo recebe:
 *   - as ferramentas NATIVAS do turno (as mesmas de produção, `AGENT_TOOL_DEFS`), sempre;
 *   - N capacidades do catálogo: a esperada pelo cenário + (N-1) distratores sorteados;
 *   - o mesmo texto, a mesma mensagem — só o tamanho do conjunto muda.
 * Os distratores de um N contêm os de todo N menor (conjuntos ANINHADOS), e a ordem da lista é sorteada: o que
 * muda de um N para o seguinte é só "mais ferramentas", nunca "ferramentas diferentes" nem "a certa no topo".
 *
 * As ferramentas NÃO têm `execute`: o modelo escolhe e o SDK devolve a escolha. Nada é executado, nenhuma mensagem
 * é enviada, não se toca em banco.
 *
 * ## O que se mede (primeira chamada de ferramenta de cada resposta)
 *   acerto        a ferramenta chamada está entre as aceitas do cenário;
 *   errada        outra ferramenta;
 *   sem_chamada   o modelo respondeu em texto e não chamou nada;
 *   inexistente   o modelo chamou um nome que não estava entre as ferramentas oferecidas.
 * E, SEPARADO do veredito: `args inválidos` = escolheu uma ferramenta que existe, mas os argumentos não cumprem o schema.
 *
 * ## Uso
 *   pnpm exec tsx scripts/eval-capacidades/rodar.ts --dry                 # só conta o tamanho, sem rede, sem custo
 *   pnpm exec tsx scripts/eval-capacidades/rodar.ts --model gpt-5.6-terra --reps 2 --max-calls 600
 *
 * A chave vem de `OPENAI_API_KEY` (ambiente) ou de `--env-file <caminho>` (linha `OPENAI_API_KEY=...`). Nunca é
 * impressa. `--max-calls` é o teto de gasto: o script para quando chega nele.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool, type Tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";
import { BLOCKED_TOOL_IDS } from "@/lib/agent-engine/edge/crm/mcp-tools";
import { allTools } from "@/lib/mcp/tools";
import { catalogEntry } from "@/lib/mcp/tools/catalog";

import { CENARIOS, type Cenario } from "./cenarios";

// ── argumentos ──────────────────────────────────────────────────────────────
function arg(nome: string, padrao?: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? (process.argv[i + 1] ?? "true") : padrao;
}
const DRY = process.argv.includes("--dry");
const FAKE = process.argv.includes("--fake");
const MODELO = arg("model", "gpt-5.6-terra")!;
const NS = (arg("ns", "10,15,20,25,30,40,52") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
const REPS = Number(arg("reps", "2"));
const MAX_CALLS = Number(arg("max-calls", "600"));
const CONCORRENCIA = Number(arg("concurrency", "4"));
const SEMENTE = Number(arg("seed", "20261113"));
const SO_CENARIOS = arg("only")?.split(",");
const SAIDA = arg("out", path.join(process.cwd(), "eval-capacidades-resultado"))!;

// ── sorteio determinístico ──────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function embaralhar<T>(lista: readonly T[], rng: () => number): T[] {
  const a = [...lista];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ── as ferramentas, como o modelo as vê ─────────────────────────────────────
/** As capacidades que um agente de verdade pode receber: sem as bloqueadas do turno e sem as só-humano. */
const DISPONIVEIS = allTools.filter((t) => !BLOCKED_TOOL_IDS.has(t.name) && !catalogEntry(t.name)?.apenasHumano);
const POR_NOME = new Map(DISPONIVEIS.map((t) => [t.name, t]));

const NATIVAS: Record<string, Tool> = Object.fromEntries(
  Object.entries(AGENT_TOOL_DEFS).map(([nome, def]) => [
    nome,
    tool({ description: (def as { description: string }).description, inputSchema: (def as { inputSchema: z.ZodTypeAny }).inputSchema }),
  ]),
);

function ferramentaMcp(nome: string): Tool {
  const def = POR_NOME.get(nome)!;
  return tool({ description: def.description, inputSchema: z.object(def.inputSchema as Record<string, z.ZodTypeAny>) });
}

/** O conjunto oferecido num cenário a um tamanho N: a esperada + (N-1) distratores aninhados, em ordem sorteada. */
function conjunto(c: Cenario, n: number): string[] {
  const outras = DISPONIVEIS.map((t) => t.name).filter((nome) => nome !== c.esperada);
  const distratores = embaralhar(outras, mulberry32(SEMENTE ^ hash(c.id)));
  const escolhidas = POR_NOME.has(c.esperada) ? [c.esperada, ...distratores.slice(0, n - 1)] : distratores.slice(0, n);
  return embaralhar(escolhidas, mulberry32(SEMENTE ^ hash(`${c.id}:${n}`)));
}

function ferramentasDe(c: Cenario, n: number): Record<string, Tool> {
  const out: Record<string, Tool> = { ...NATIVAS };
  for (const nome of conjunto(c, n)) out[nome] = ferramentaMcp(nome);
  return out;
}

// ── o texto, igual em todas as chamadas ─────────────────────────────────────
const SISTEMA = [
  "Você é a Marcela, assistente de atendimento de uma clínica odontológica, falando pelo WhatsApp.",
  "Seja cordial e objetiva. Use as ferramentas para consultar e agir no sistema; para falar com quem escreve, use send_message.",
  "Contexto desta conversa: o contato e o negócio já estão identificados (contact_id e lead_id corretos nas ferramentas que os pedem).",
  "Tipos de atendimento cadastrados: Avaliação (30 min), Limpeza (45 min), Clareamento (60 min), Implante (90 min).",
  "Hoje é quinta-feira, 13/11/2026, 10h (horário de Brasília).",
  "Quando a mensagem vier marcada com (equipe), quem escreve é uma pessoa da equipe interna dando uma ordem a você, não um cliente.",
].join("\n");

// ── chave ───────────────────────────────────────────────────────────────────
function lerChave(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const arquivo = arg("env-file");
  if (!arquivo || !fs.existsSync(arquivo)) return null;
  for (const linha of fs.readFileSync(arquivo, "utf8").split(/\r?\n/)) {
    const m = /^\s*OPENAI_API_KEY\s*=\s*(.+?)\s*$/.exec(linha);
    if (m) return m[1]!.replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * Um "modelo" que não é modelo: escolhe a ferramenta esperada, EXCETO com N alto, onde erra de propósito num
 * cenário em cada cinco (para a contagem ter o que contar), e num outro devolve texto sem chamar nada. Só prova que
 * o veredito, a agregação e a tabela funcionam — não diz nada sobre nenhum modelo de verdade.
 */
function modeloSimulado() {
  return new MockLanguageModelV3({
    modelId: "simulado",
    doGenerate: async (opcoes) => {
      const texto = JSON.stringify(opcoes.prompt);
      const cen = CENARIOS.find((c) => texto.includes(c.mensagem))!;
      const oferecidas = (opcoes.tools ?? []).map((t) => t.name);
      const n = oferecidas.filter((nome) => POR_NOME.has(nome)).length;
      const azar = hash(cen.id) % 5 === 0;
      let escolha: string | null = oferecidas.includes(cen.esperada) ? cen.esperada : (oferecidas[0] ?? null);
      if (azar && n >= 40) escolha = oferecidas.find((nome) => nome !== cen.esperada && !(cen.aceitas ?? []).includes(nome)) ?? escolha;
      if (azar && n === 30) escolha = null;
      const usage = {
        inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 20, text: 20, reasoning: 0 },
      };
      if (!escolha) return { content: [{ type: "text" as const, text: "ok" }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] };
      return {
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: escolha, input: "{}" }],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

// ── execução ────────────────────────────────────────────────────────────────
type Veredito = "acerto" | "errada" | "sem_chamada" | "inexistente";
interface Linha {
  cenario: string;
  n: number;
  rep: number;
  veredito: Veredito;
  /** A ferramenta escolhida existia, mas os argumentos não cumpriram o schema. Independe do veredito. */
  argsInvalidos: boolean;
  chamou: string | null;
  tokensEntrada: number;
  tokensSaida: number;
  ms: number;
}

const ESTIMA_TOKENS = (texto: string) => Math.ceil(texto.length / 3.6);

function tamanhoEstimado(c: Cenario, n: number): number {
  const ferramentas = ferramentasDe(c, n);
  const json = JSON.stringify(
    Object.entries(ferramentas).map(([nome, t]) => ({
      nome,
      d: (t as { description?: string }).description,
      s: z.toJSONSchema((t as { inputSchema: z.ZodType }).inputSchema),
    })),
  );
  return ESTIMA_TOKENS(SISTEMA + c.mensagem + json);
}

async function uma(modelo: ReturnType<ReturnType<typeof createOpenAI>>, c: Cenario, n: number, rep: number): Promise<Linha> {
  const ferramentas = ferramentasDe(c, n);
  const aceitas = new Set([c.esperada, ...(c.aceitas ?? [])]);
  const t0 = Date.now();
  const r = await generateText({ model: modelo, system: SISTEMA, prompt: c.mensagem, tools: ferramentas, toolChoice: "auto", maxRetries: 4 });
  const primeira = r.toolCalls[0] as { toolName: string; invalid?: boolean; input?: unknown } | undefined;
  // A ESCOLHA da ferramenta e a VALIDADE dos argumentos são medidas separadas: um modelo que escolhe certo e erra um
  // campo escolheu certo — contá-lo como erro de escolha esconderia o que este teste existe para medir.
  let veredito: Veredito;
  if (!primeira) veredito = "sem_chamada";
  else if (!(primeira.toolName in ferramentas)) veredito = "inexistente";
  else veredito = aceitas.has(primeira.toolName) ? "acerto" : "errada";
  return {
    cenario: c.id,
    n,
    rep,
    veredito,
    argsInvalidos: Boolean(primeira?.invalid) && primeira!.toolName in ferramentas,
    chamou: primeira?.toolName ?? null,
    tokensEntrada: r.usage?.inputTokens ?? 0,
    tokensSaida: r.usage?.outputTokens ?? 0,
    ms: Date.now() - t0,
  };
}

async function main(): Promise<void> {
  // Higiene do próprio teste: todo nome citado nos cenários tem de existir.
  const conhecidos = new Set([...POR_NOME.keys(), ...Object.keys(NATIVAS)]);
  for (const c of CENARIOS) {
    for (const nome of [c.esperada, ...(c.aceitas ?? [])]) {
      if (!conhecidos.has(nome)) throw new Error(`cenário "${c.id}" cita a ferramenta inexistente "${nome}"`);
    }
  }
  const cenarios = SO_CENARIOS ? CENARIOS.filter((c) => SO_CENARIOS.includes(c.id)) : CENARIOS;
  const maxN = Math.max(...NS);
  if (maxN > DISPONIVEIS.length + 0) console.log(`aviso: o catálogo tem ${DISPONIVEIS.length} capacidades disponíveis; N acima disso vale ${DISPONIVEIS.length}.`);

  const total = cenarios.length * NS.length * REPS;
  console.log(`modelo=${MODELO}  cenários=${cenarios.length}  N=${NS.join(",")}  reps=${REPS}  chamadas=${total}  nativas=${Object.keys(NATIVAS).length}  capacidades disponíveis=${DISPONIVEIS.length}`);

  console.log("\nTamanho estimado do pedido (tokens de entrada, só ferramentas+texto), por N:");
  let entradaTotal = 0;
  for (const n of NS) {
    const media = Math.round(cenarios.reduce((s, c) => s + tamanhoEstimado(c, n), 0) / cenarios.length);
    entradaTotal += media * cenarios.length * REPS;
    console.log(`  N=${String(n).padStart(2)}  ~${media} tokens por chamada`);
  }
  console.log(`Entrada total estimada: ~${(entradaTotal / 1e6).toFixed(2)} milhões de tokens em ${total} chamadas (a saída, com raciocínio, é à parte).`);
  if (DRY) return;

  if (total > MAX_CALLS) throw new Error(`${total} chamadas passam do teto --max-calls ${MAX_CALLS}. Aumente o teto de propósito ou reduza --reps/--ns.`);
  let modelo: ReturnType<ReturnType<typeof createOpenAI>>;
  if (FAKE) {
    modelo = modeloSimulado() as unknown as typeof modelo;
    console.log("\n[--fake] modelo SIMULADO: sem rede, sem chave, sem custo. Serve só para provar que a contagem funciona.");
  } else {
    const chave = lerChave();
    if (!chave) throw new Error("Sem chave: defina OPENAI_API_KEY ou passe --env-file <arquivo com OPENAI_API_KEY=...>.");
    modelo = createOpenAI({ apiKey: chave })(MODELO);
  }
  const fila: Array<{ c: Cenario; n: number; rep: number }> = [];
  for (const rep of Array.from({ length: REPS }, (_, i) => i)) for (const n of NS) for (const c of cenarios) fila.push({ c, n, rep });

  fs.mkdirSync(SAIDA, { recursive: true });
  const arquivo = path.join(SAIDA, `linhas-${MODELO}.jsonl`);
  const linhas: Linha[] = [];
  let feitas = 0;
  let falhas = 0;
  async function trabalhador(): Promise<void> {
    for (;;) {
      const item = fila.shift();
      if (!item) return;
      try {
        const l = await uma(modelo, item.c, item.n, item.rep);
        linhas.push(l);
        fs.appendFileSync(arquivo, JSON.stringify(l) + "\n");
      } catch (e) {
        falhas += 1;
        console.log(`falha de chamada (${item.c.id} N=${item.n}): ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
        if (falhas >= 15) { console.log("muitas falhas seguidas; parando."); fila.length = 0; }
      }
      feitas += 1;
      if (feitas % 25 === 0) console.log(`  ${feitas}/${total}`);
    }
  }
  await Promise.all(Array.from({ length: CONCORRENCIA }, () => trabalhador()));

  // ── resultado ─────────────────────────────────────────────────────────────
  console.log("\nN  | amostras | acerto | errada | sem chamada | inexistente | args inválidos | tokens entrada (média) | ms (média)");
  const porN: Record<number, Linha[]> = {};
  for (const l of linhas) (porN[l.n] ??= []).push(l);
  const tabela: string[] = [];
  for (const n of NS) {
    const ls = porN[n] ?? [];
    if (ls.length === 0) continue;
    const pct = (v: Veredito) => ((100 * ls.filter((l) => l.veredito === v).length) / ls.length).toFixed(1);
    const argsRuins = ((100 * ls.filter((l) => l.argsInvalidos).length) / ls.length).toFixed(1);
    const linha = `${String(n).padStart(2)} | ${String(ls.length).padStart(8)} | ${pct("acerto").padStart(5)}% | ${pct("errada").padStart(5)}% | ${pct("sem_chamada").padStart(10)}% | ${pct("inexistente").padStart(10)}% | ${argsRuins.padStart(13)}% | ${String(Math.round(ls.reduce((s, l) => s + l.tokensEntrada, 0) / ls.length)).padStart(22)} | ${Math.round(ls.reduce((s, l) => s + l.ms, 0) / ls.length)}`;
    console.log(linha);
    tabela.push(linha);
  }
  // Quem mais se confunde: as ferramentas esperadas com menor acerto nos N altos.
  const erros = linhas.filter((l) => l.veredito !== "acerto");
  const porCenario: Record<string, number> = {};
  for (const l of erros) porCenario[l.cenario] = (porCenario[l.cenario] ?? 0) + 1;
  console.log("\nCenários que mais erraram (qtd de erros em todas as chamadas):");
  for (const [id, q] of Object.entries(porCenario).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    const exemplo = erros.find((l) => l.cenario === id);
    console.log(`  ${id}: ${q}  (ex.: chamou ${exemplo?.chamou ?? "nada"} em vez de ${CENARIOS.find((c) => c.id === id)?.esperada})`);
  }
  const entrada = linhas.reduce((s, l) => s + l.tokensEntrada, 0);
  const saida = linhas.reduce((s, l) => s + l.tokensSaida, 0);
  console.log(`\nTokens usados de verdade: entrada=${entrada}  saída=${saida}  chamadas=${linhas.length}  falhas=${falhas}`);
  fs.writeFileSync(path.join(SAIDA, `resumo-${MODELO}.txt`), tabela.join("\n") + `\nentrada=${entrada} saida=${saida}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
