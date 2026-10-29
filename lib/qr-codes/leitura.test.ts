import { describe, expect, it } from "vitest";

import { dispositivoDoAgente, ehLeituraDeRobo } from "./leitura";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

describe("ehLeituraDeRobo", () => {
  it("pré-visualização de link e robôs não contam", () => {
    for (const ua of [
      "facebookexternalhit/1.1",
      "WhatsApp/2.23.20.0 A",
      "Googlebot/2.1",
      "Slackbot-LinkExpanding 1.0",
      "TelegramBot (like TwitterBot)",
      "curl/8.4.0",
    ]) {
      expect(ehLeituraDeRobo(ua), ua).toBe(true);
    }
  });
  it("sem user-agent não conta (não é a câmera de um celular)", () => {
    expect(ehLeituraDeRobo(null)).toBe(true);
    expect(ehLeituraDeRobo("  ")).toBe(true);
  });
  it("navegador de celular e de computador contam", () => {
    expect(ehLeituraDeRobo(IPHONE)).toBe(false);
    expect(ehLeituraDeRobo(ANDROID)).toBe(false);
    expect(ehLeituraDeRobo(WINDOWS)).toBe(false);
  });
});

describe("dispositivoDoAgente", () => {
  it("Android (que diz Linux) é celular, não computador", () => {
    expect(dispositivoDoAgente(ANDROID)).toBe("celular");
  });
  it("iPhone é celular, Windows é computador, vazio é outro", () => {
    expect(dispositivoDoAgente(IPHONE)).toBe("celular");
    expect(dispositivoDoAgente(WINDOWS)).toBe("computador");
    expect(dispositivoDoAgente(null)).toBe("outro");
  });
});
