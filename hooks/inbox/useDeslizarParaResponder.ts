"use client";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import {
  CONTROLES_QUE_NAO_INICIAM_O_GESTO,
  LIMIAR_PARA_RESPONDER,
  lerGesto,
  soltouParaResponder,
  TEMPO_DO_TOQUE_LONGO_MS,
} from "@/lib/inbox/deslizar-para-responder";

/**
 * Os gestos de toque de uma mensagem: deslizar para responder, e o toque longo para começar a
 * encaminhar (como no WhatsApp do celular).
 *
 * Só ao TOQUE: com o mouse, arrastar é selecionar texto, e os botões já estão ali. Quem monta aplica
 * `props` e `style` no elemento que anda; `progresso` (0 a 1) é para a dica visual que aparece atrás.
 *
 * `touch-action: pan-y` é o que faz o deslize existir: sem ele o navegador toma o movimento horizontal
 * para si (e dispara `pointercancel`), e a bolha nunca anda. Com ele a rolagem vertical segue do
 * navegador, e o horizontal chega aqui.
 *
 * O toque longo e o deslize disputam o mesmo dedo, e quem ganha é quem acontecer primeiro: andar além
 * da folga desarma o toque longo (era uma rolagem ou um deslize), e o toque longo que disparou impede o
 * deslize de responder ao soltar (o dedo já estava fazendo outra coisa).
 */
export function useDeslizarParaResponder(
  aoResponder: (() => void) | undefined,
  aoToqueLongo?: () => void,
) {
  const [deslocamento, setDeslocamento] = useState(0);
  const inicio = useRef<{ x: number; y: number; id: number } | null>(null);
  const ultimo = useRef(0);
  const relogioDoToqueLongo = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toqueLongoDisparou = useRef(false);

  const desarmarToqueLongo = () => {
    if (relogioDoToqueLongo.current) clearTimeout(relogioDoToqueLongo.current);
    relogioDoToqueLongo.current = null;
  };
  // Desmontar com o dedo ainda parado não pode deixar o relógio disparar depois.
  useEffect(() => desarmarToqueLongo, []);

  const reiniciar = () => {
    desarmarToqueLongo();
    inicio.current = null;
    ultimo.current = 0;
    setDeslocamento(0);
  };

  if (!aoResponder && !aoToqueLongo) return { props: {}, style: undefined, deslocamento: 0, progresso: 0 };

  const props = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      if ((e.target as HTMLElement).closest(CONTROLES_QUE_NAO_INICIAM_O_GESTO)) return;
      inicio.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      ultimo.current = 0;
      toqueLongoDisparou.current = false;
      desarmarToqueLongo();
      if (aoToqueLongo) {
        relogioDoToqueLongo.current = setTimeout(() => {
          relogioDoToqueLongo.current = null;
          toqueLongoDisparou.current = true;
          aoToqueLongo();
        }, TEMPO_DO_TOQUE_LONGO_MS);
      }
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const i = inicio.current;
      if (!i || e.pointerId !== i.id) return;
      const leitura = lerGesto(e.clientX - i.x, e.clientY - i.y);
      // Andou: já não é um toque parado.
      if (leitura.estado !== "indeciso") desarmarToqueLongo();
      if (leitura.estado === "rolagem") {
        reiniciar();
        return;
      }
      if (leitura.estado === "deslizando" && aoResponder && !toqueLongoDisparou.current) {
        ultimo.current = leitura.deslocamento;
        setDeslocamento(leitura.deslocamento);
      }
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      const i = inicio.current;
      if (!i || e.pointerId !== i.id) return;
      const valeu = soltouParaResponder(ultimo.current) && !toqueLongoDisparou.current;
      reiniciar();
      if (valeu) aoResponder?.();
    },
    onPointerCancel: reiniciar,
    // No Android o toque longo também abre o menu do navegador sobre o texto; quando ele é NOSSO (começa
    // a seleção), o menu atrapalha. Só quando o toque longo disparou: o botão direito do mouse e o menu
    // de sempre continuam como eram.
    onContextMenu: (e: { preventDefault: () => void }) => {
      if (toqueLongoDisparou.current) e.preventDefault();
    },
  };

  const style = {
    touchAction: "pan-y" as const,
    transform: deslocamento ? `translateX(${deslocamento}px)` : undefined,
    // Acompanha o dedo sem atraso; ao soltar, volta com suavidade.
    transition: deslocamento ? "none" : "transform 160ms ease-out",
  };

  return { props, style, deslocamento, progresso: Math.min(1, deslocamento / LIMIAR_PARA_RESPONDER) };
}
