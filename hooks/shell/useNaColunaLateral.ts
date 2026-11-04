"use client";
import { useSyncExternalStore } from "react";

/**
 * A casca de navegação (`components/shell/TopBar.tsx`) é uma barra no topo no celular e uma coluna
 * à esquerda de `md` (768px) em diante. O CSS faz a troca sozinho; ESTE hook existe só para o que o
 * CSS não alcança: o lado para onde um menu suspenso abre (`side` do Radix é uma propriedade, não
 * uma classe). Na coluna, o menu tem que abrir PARA O LADO — para baixo ele bateria na borda da tela.
 *
 * `useSyncExternalStore` com `false` no servidor: o primeiro desenho é sempre o do celular, e só
 * depois da hidratação o valor real entra. Quem usa isto só desenha menu FECHADO, então a troca
 * não é visível e não há divergência de hidratação.
 */
const CONSULTA = "(min-width: 768px)";

function assinar(aoMudar: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const lista = window.matchMedia(CONSULTA);
  lista.addEventListener("change", aoMudar);
  return () => lista.removeEventListener("change", aoMudar);
}

function agora(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(CONSULTA).matches;
}

export function useNaColunaLateral(): boolean {
  return useSyncExternalStore(assinar, agora, () => false);
}
