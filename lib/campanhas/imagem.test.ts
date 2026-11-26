// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { prepararImagem } from "./imagem";

async function imagemDe(formato: "webp" | "png" | "jpeg" | "gif", largura = 40): Promise<Buffer> {
  const base = sharp({ create: { width: largura, height: largura, channels: 3, background: { r: 30, g: 120, b: 60 } } });
  if (formato === "webp") return base.webp().toBuffer();
  if (formato === "png") return base.png().toBuffer();
  if (formato === "gif") return base.gif().toBuffer();
  return base.jpeg().toBuffer();
}

describe("prepararImagem", () => {
  it("WEBP vira JPG (o WhatsApp trata WEBP como figurinha)", async () => {
    const r = await prepararImagem(await imagemDe("webp"), "image/webp");
    expect(r.ok && r.mime).toBe("image/jpeg");
    expect(r.ok && (await sharp(r.bytes).metadata()).format).toBe("jpeg");
  });

  it("PNG continua PNG e JPG continua JPG", async () => {
    const png = await prepararImagem(await imagemDe("png"), "image/png");
    expect(png.ok && png.mime).toBe("image/png");
    const jpg = await prepararImagem(await imagemDe("jpeg"), "image/jpeg");
    expect(jpg.ok && jpg.mime).toBe("image/jpeg");
  });

  it("reduz imagem grande para no máximo 1600 px", async () => {
    const r = await prepararImagem(await imagemDe("jpeg", 3000), "image/jpeg");
    const meta = r.ok ? await sharp(r.bytes).metadata() : null;
    expect(meta?.width).toBe(1600);
  });

  it("o conteúdo manda: PNG com tipo informado de JPG segue como PNG", async () => {
    const r = await prepararImagem(await imagemDe("png"), "image/jpeg");
    expect(r.ok && r.mime).toBe("image/png");
  });

  it("recusa GIF, texto disfarçado e arquivo vazio", async () => {
    expect((await prepararImagem(await imagemDe("gif"), "image/gif")).ok).toBe(false);
    expect((await prepararImagem(Buffer.from("não sou imagem"), "image/jpeg")).ok).toBe(false);
    expect((await prepararImagem(Buffer.alloc(0), "image/png")).ok).toBe(false);
  });
});
