/**
 * Prepara a arte da campanha para o WhatsApp: aceita JPG, PNG e WEBP; WEBP vira
 * JPG (o WhatsApp trata WEBP como figurinha), e qualquer imagem maior que
 * 1600 px no lado maior é reduzida. Os metadados (EXIF, localização) saem — a
 * arte vai para centenas de pessoas.
 */
import type sharpTipo from "sharp";

import { MAX_BYTES_DA_IMAGEM, MIMES_DE_IMAGEM_ACEITOS } from "./parametros";

/**
 * `sharp` é nativo: carregado só aqui, e a falta dele não derruba a rota. Sem
 * ele, JPG e PNG de até 5 MB seguem como vieram; WEBP é recusado com o motivo.
 */
async function carregarSharp(): Promise<typeof sharpTipo | null> {
  try {
    return (await import("sharp")).default;
  } catch {
    return null;
  }
}

function assinatura(bytes: Buffer): "jpeg" | "png" | "webp" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

const LADO_MAXIMO = 1600;

export type ImagemPreparada = { ok: true; bytes: Buffer; mime: "image/jpeg" | "image/png"; ext: "jpg" | "png" };
export type ImagemRecusada = { ok: false; motivo: string };

export async function prepararImagem(bytes: Buffer, mimeInformado: string): Promise<ImagemPreparada | ImagemRecusada> {
  const mime = mimeInformado.split(";")[0]!.trim().toLowerCase();
  if (!(MIMES_DE_IMAGEM_ACEITOS as readonly string[]).includes(mime)) {
    return { ok: false, motivo: "Use uma imagem JPG, PNG ou WEBP." };
  }
  if (bytes.length === 0) return { ok: false, motivo: "O arquivo está vazio." };
  if (bytes.length > 4 * MAX_BYTES_DA_IMAGEM) return { ok: false, motivo: "A imagem passa de 20 MB." };

  // O conteúdo manda, não o nome: um PNG com extensão .jpg segue como PNG.
  const formato = assinatura(bytes);
  if (formato === null) return { ok: false, motivo: "Não foi possível ler a imagem. Use JPG, PNG ou WEBP." };

  const sharp = await carregarSharp();
  if (!sharp) {
    if (formato === "webp") return { ok: false, motivo: "Envie a imagem em JPG ou PNG." };
    if (bytes.length > MAX_BYTES_DA_IMAGEM) return { ok: false, motivo: "A imagem passa de 5 MB. Use uma versão menor." };
    return formato === "png"
      ? { ok: true, bytes, mime: "image/png", ext: "png" }
      : { ok: true, bytes, mime: "image/jpeg", ext: "jpg" };
  }
  try {
    await sharp(bytes).metadata();
  } catch {
    return { ok: false, motivo: "Não foi possível ler a imagem. Ela pode estar corrompida." };
  }

  const base = sharp(bytes).rotate().resize({ width: LADO_MAXIMO, height: LADO_MAXIMO, fit: "inside", withoutEnlargement: true });
  const saida =
    formato === "png"
      ? { bytes: await base.png({ compressionLevel: 9 }).toBuffer(), mime: "image/png" as const, ext: "png" as const }
      : { bytes: await base.jpeg({ quality: 85, mozjpeg: true }).toBuffer(), mime: "image/jpeg" as const, ext: "jpg" as const };

  if (saida.bytes.length > MAX_BYTES_DA_IMAGEM) {
    return { ok: false, motivo: "A imagem continua acima de 5 MB depois de reduzida. Use uma versão menor." };
  }
  return { ok: true, ...saida };
}
