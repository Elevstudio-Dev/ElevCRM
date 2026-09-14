/**
 * Stateless HMAC-SHA256 invite token. Self-contained payload, signed and
 * base64url-encoded — no DB row required to issue. Verified at accept time.
 *
 * Format: `<body>.<sig>` where
 *   - body = base64url(JSON({invite_id, email, organization_id, role, exp}))
 *   - sig  = base64url(HMAC_SHA256(secret, body))
 *
 * Secret resolution: INVITE_TOKEN_SECRET → INTERNAL_SECRET → "dev-fallback"
 * (o último SÓ fora de produção). Verification uses `timingSafeEqual` to
 * avoid timing oracles.
 *
 * O segredo vem do `env` validado por `lib/env.ts`, e não de `process.env`
 * cru — era o item (b) do risco T4 do threat model: lendo cru, este módulo não
 * herdava garantia nenhuma do schema. Com `env`, em produção o boot já recusa
 * subir sem `INTERNAL_SECRET`, e é essa a primeira defesa.
 *
 * A segunda, aqui: o "dev-fallback" é uma string do repositório público — um
 * token assinado com ela é um token que qualquer um forja, e convite dá acesso
 * a uma organização inteira. Em produção, sem segredo, ASSINAR lança (quem
 * assina precisa saber) e VERIFICAR devolve `null` (nenhum token é válido) —
 * sem lançar, porque `verifyInviteToken` roda no render da página pública de
 * cadastro, e um throw ali é 500 para qualquer visitante com `?invite=`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

/**
 * O segredo em vigor, ou `null` quando não há nenhum e estamos em produção.
 * `||`, e não `??`: variável VAZIA (como vem no `.env.example`) é ausência,
 * não um segredo de zero caracteres.
 */
function segredoConfigurado(): string | null {
  const configurado = env.INVITE_TOKEN_SECRET || env.INTERNAL_SECRET;
  if (configurado) return configurado;
  if (process.env.NODE_ENV === "production") return null;
  return "dev-fallback";
}

export interface InvitePayload {
  invite_id: string;
  email: string;
  organization_id: string;
  role: string;
  exp: number; // epoch seconds
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signInviteToken(payload: InvitePayload): string {
  const secret = segredoConfigurado();
  if (secret === null) {
    throw new Error(
      "Token de convite sem segredo: defina INTERNAL_SECRET (ou INVITE_TOKEN_SECRET) em produção.",
    );
  }
  const json = JSON.stringify(payload);
  const body = b64url(Buffer.from(json, "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyInviteToken(token: string): InvitePayload | null {
  const secret = segredoConfigurado();
  if (secret === null) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  if (sig.length !== expected.length) return null;

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let payload: InvitePayload;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    payload = JSON.parse(json) as InvitePayload;
  } catch {
    return null;
  }

  if (
    typeof payload.invite_id !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.organization_id !== "string" ||
    typeof payload.role !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }

  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

export const INVITE_TTL_SECONDS = 60 * 60 * 24; // 24h
