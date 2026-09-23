/**
 * UM DESPACHO CERTO DE MENTIRA, COM COMPORTAMENTO DE VERDADE.
 *
 * Existe por uma razão só: provar a integração HOJE, enquanto o Despacho Certo
 * de verdade ainda não expõe a API. O que ele NÃO é: um mock dentro do CRM. O
 * Elev CRM fala HTTP com ele, autentica com Bearer, recebe JSON, grava o
 * vínculo e trata os erros dele — tudo o que vai acontecer com o sistema real.
 * Quando a API real existir, muda a URL em Configurações e mais nada.
 *
 * O que ele implementa, exatamente o contrato de
 * `lib/integrations/despachocerto/contrato.ts`:
 *
 *   GET  /api/integrations/elevcrm/clients/lookup?phone=&document=
 *   POST /api/integrations/elevcrm/clients
 *   POST /_demo/work-order        ← só do stub: dispara o webhook da OS
 *   GET  /_demo/state             ← só do stub: o que ele tem guardado
 *
 * Estado em memória: some quando o processo morre, e é o que se quer numa
 * demonstração — cada rodada começa limpa.
 *
 * Uso:
 *   pnpm exec tsx scripts/stub-despachocerto.ts
 *     STUB_DC_PORT=4010            porta (default 4010)
 *     STUB_DC_KEY=chave-demo       a chave que o CRM precisa mandar
 *     STUB_DC_WEBHOOK=<url>        para onde avisar da OS
 *     STUB_DC_SECRET=<segredo>     segredo do HMAC do corpo
 */
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORTA = Number(process.env.STUB_DC_PORT ?? "4010");
const CHAVE = process.env.STUB_DC_KEY ?? "chave-demo";

interface Cliente {
  id: string;
  name: string;
  phone: string;
  document: string | null;
  email: string | null;
  plates: string[];
  url: string | null;
}

const clientes: Cliente[] = [];
let sequenciaDeOs = 1000;

const soDigitos = (v: string): string => v.replace(/\D/g, "");

/** O mesmo cliente é o do MESMO telefone (ou documento) — a regra de lá. */
function acharCliente(chaves: { phone?: string; document?: string }): Cliente | null {
  const tel = chaves.phone ? soDigitos(chaves.phone) : "";
  const doc = chaves.document ? soDigitos(chaves.document) : "";
  return (
    clientes.find((c) => {
      if (doc && c.document && soDigitos(c.document) === doc) return true;
      // Telefone casa pelos 8 últimos dígitos: DDI/DDD entram de formas
      // diferentes em cada sistema, e exigir igualdade exata criaria duplicado
      // justamente no caso que este stub existe para provar.
      if (tel && c.phone && soDigitos(c.phone).slice(-8) === tel.slice(-8)) return true;
      return false;
    }) ?? null
  );
}

function responder(res: ServerResponse, status: number, corpo: unknown): void {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(texto);
}

function autorizado(req: IncomingMessage): boolean {
  return (req.headers.authorization ?? "") === `Bearer ${CHAVE}`;
}

async function lerCorpo(req: IncomingMessage): Promise<unknown> {
  const partes: Buffer[] = [];
  for await (const p of req) partes.push(p as Buffer);
  const texto = Buffer.concat(partes).toString("utf8");
  try {
    return texto ? JSON.parse(texto) : {};
  } catch {
    return {};
  }
}

/** Avisa o Elev CRM de uma OS, assinando o corpo como o sistema real fará. */
async function avisarDaOs(evento: unknown): Promise<{ status: number; corpo: string }> {
  const url = process.env.STUB_DC_WEBHOOK;
  const segredo = process.env.STUB_DC_SECRET;
  if (!url) return { status: 0, corpo: "STUB_DC_WEBHOOK não configurado" };
  const corpo = JSON.stringify(evento);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (segredo) {
    headers["X-DespachoCerto-Signature"] = createHmac("sha256", segredo).update(corpo).digest("hex");
  }
  const res = await fetch(url, { method: "POST", headers, body: corpo });
  return { status: res.status, corpo: (await res.text()).slice(0, 300) };
}

const servidor = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORTA}`);
    const rota = `${req.method} ${url.pathname}`;

    // ── busca ──────────────────────────────────────────────────────────────
    if (rota === "GET /api/integrations/elevcrm/clients/lookup") {
      if (!autorizado(req)) return responder(res, 401, { error: "chave inválida" });
      const cliente = acharCliente({
        phone: url.searchParams.get("phone") ?? undefined,
        document: url.searchParams.get("document") ?? undefined,
      });
      return responder(res, 200, { cliente });
    }

    // ── cadastro ───────────────────────────────────────────────────────────
    if (rota === "POST /api/integrations/elevcrm/clients") {
      if (!autorizado(req)) return responder(res, 401, { error: "chave inválida" });
      const corpo = (await lerCorpo(req)) as Record<string, unknown>;
      const name = String(corpo.name ?? "").trim();
      const phone = String(corpo.phone ?? "").trim();
      if (name.length < 2 || phone.length < 8) {
        return responder(res, 422, { error: "nome e telefone são obrigatórios" });
      }

      // Idempotência: a promessa do contrato é do outro lado, e o stub a cumpre.
      const jaExiste = acharCliente({ phone, document: String(corpo.document ?? "") });
      if (jaExiste) return responder(res, 200, { cliente: jaExiste, existente: true });

      const placa = String(corpo.plate ?? "").replace(/[\s-]/g, "").toUpperCase();
      const cliente: Cliente = {
        id: randomUUID(),
        name,
        phone,
        document: String(corpo.document ?? "") || null,
        email: String(corpo.email ?? "") || null,
        plates: placa ? [placa] : [],
        url: null,
      };
      cliente.url = `http://localhost:${PORTA}/_demo/cliente/${cliente.id}`;
      clientes.push(cliente);
      console.info(`[stub-dc] cliente criado: ${cliente.name} (${cliente.id})`);
      return responder(res, 201, { cliente, existente: false });
    }

    // ── abrir uma OS e avisar o CRM (o gatilho da demonstração) ────────────
    if (rota === "POST /_demo/work-order") {
      const corpo = (await lerCorpo(req)) as Record<string, unknown>;
      const cliente =
        clientes.find((c) => c.id === corpo.client_id) ??
        acharCliente({ phone: String(corpo.phone ?? "") });
      if (!cliente) return responder(res, 404, { error: "nenhum cliente com esse id/telefone" });

      const placa = String(corpo.plate ?? cliente.plates[0] ?? "").replace(/[\s-]/g, "").toUpperCase();
      if (placa && !cliente.plates.includes(placa)) cliente.plates.push(placa);
      sequenciaDeOs += 1;
      const numero = String(corpo.number ?? sequenciaDeOs);

      const evento = {
        event: "work_order.created",
        work_order: {
          id: randomUUID(),
          number: numero,
          client_id: cliente.id,
          plate: placa || null,
          additional_plates: [],
          status: "Em andamento",
          url: `http://localhost:${PORTA}/_demo/os/${numero}`,
        },
      };
      const resposta = await avisarDaOs(evento);
      console.info(`[stub-dc] OS ${numero} para ${cliente.name} → CRM respondeu ${resposta.status}`);
      return responder(res, 200, { evento, crm: resposta });
    }

    if (rota === "GET /_demo/state") {
      return responder(res, 200, { clientes, proxima_os: sequenciaDeOs + 1 });
    }

    return responder(res, 404, { error: `sem rota para ${rota}` });
  })().catch((err: unknown) => {
    console.error("[stub-dc] falhou", err);
    if (!res.headersSent) responder(res, 500, { error: "erro no stub" });
  });
});

servidor.listen(PORTA, () => {
  console.info(`[stub-dc] Despacho Certo (demonstração) em http://localhost:${PORTA}`);
  console.info(`[stub-dc] chave esperada: ${CHAVE}`);
  console.info(`[stub-dc] avisa OS em: ${process.env.STUB_DC_WEBHOOK ?? "(não configurado)"}`);
});
