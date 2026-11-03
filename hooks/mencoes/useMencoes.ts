"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";

import { aplicarMencao, filtrarCandidatos, gatilhoDeMencao, mencoesQueSobraram } from "@/lib/mencoes/texto";
import { chaveDaMencao, type CandidatoDeMencao, type Mencao } from "@/lib/mencoes/tipos";

interface Opts {
  /** Quem pode ser marcado aqui. Lista vazia DESLIGA o recurso (conversa 1:1, por exemplo). */
  candidatos: ReadonlyArray<CandidatoDeMencao>;
  /** Como a linha escolhida vira a marcação que vai guardada. */
  paraMencao: (c: CandidatoDeMencao) => Mencao;
  texto: string;
  setTexto: (t: string) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  /** Depois de o texto mudar por dentro (inserir o nome) — o composer reajusta a altura. */
  aoInserir?: () => void;
}

/**
 * O `@` do campo de texto: abre a lista ao digitar `@`, filtra pelo que vem
 * depois, escolhe com ↑ ↓ Enter/Tab (ou toque) e fecha com Esc.
 *
 * O hook NÃO é dono do texto — quem o possui (o composer, o chat) continua
 * sendo, e só repassa os três eventos do campo. Ele é dono de duas coisas: a
 * posição do cursor (o `@` que está sendo completado depende dela) e a lista de
 * quem foi marcado.
 *
 * O Enter só escolhe quando a lista está ABERTA, isto é, quando há alguém a
 * escolher. `@` sozinho numa frase sem nenhum nome que case não rouba o Enter de
 * quem só quer enviar.
 */
export function useMencoes({ candidatos, paraMencao, texto, setTexto, taRef, aoInserir }: Opts) {
  const [cursor, setCursor] = useState(0);
  const [indice, setIndice] = useState(0);
  // A lista que o Esc fechou, ou que acabou de cumprir o seu papel (alguém foi
  // escolhido): guarda ONDE o `@` estava e o que havia depois dele. Enquanto o que
  // se digita for só continuação disso, a lista fica fechada — sem isto, escolher
  // "Ana Souza" deixaria a lista aberta (o espaço depois do nome ainda é "consulta",
  // porque nomes têm sobrenome) e o Enter seguinte escolheria de novo em vez de enviar.
  // Apagar de volta, ou começar outro `@`, a reabre.
  const [dispensado, setDispensado] = useState<{ inicio: number; consulta: string } | null>(null);
  const [escolhidas, setEscolhidas] = useState<Mencao[]>([]);

  const gatilho = candidatos.length > 0 ? gatilhoDeMencao(texto, cursor) : null;
  const itens = useMemo(
    () => (gatilho ? filtrarCandidatos(candidatos, gatilho.consulta) : []),
    [candidatos, gatilho],
  );
  const dispensada =
    !!gatilho && !!dispensado && gatilho.inicio === dispensado.inicio && gatilho.consulta.startsWith(dispensado.consulta);
  const aberto = !!gatilho && itens.length > 0 && !dispensada;
  const ativo = Math.min(indice, Math.max(itens.length - 1, 0));

  // O ESC DA LISTA NÃO PODE FECHAR A JANELA EM QUE O CAMPO ESTÁ.
  //
  // O chat da equipe mora numa gaveta (Radix `Sheet`), e o Radix fecha a gaveta com um ouvinte de `keydown`
  // no `document`, na fase de CAPTURA — que roda ANTES de qualquer `onKeyDown` do campo. Tratar o Esc só no
  // campo (como o Enter e as setas) chega tarde: a lista fecha e a gaveta vai junto, levando o texto que
  // estava sendo escrito. Medido pela spec e2e (a unitária não via, porque o campo sozinho não tem gaveta).
  //
  // O ouvinte fica no `window`, também em captura: é a primeira parada do evento. Só existe enquanto a
  // lista está ABERTA — com ela fechada, o Esc volta a ser da gaveta, como sempre foi.
  const inicioAberto = aberto ? gatilho!.inicio : null;
  const consultaAberta = aberto ? gatilho!.consulta : null;
  useEffect(() => {
    if (inicioAberto === null || consultaAberta === null) return;
    const fechar = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setDispensado({ inicio: inicioAberto, consulta: consultaAberta });
    };
    window.addEventListener("keydown", fechar, true);
    return () => window.removeEventListener("keydown", fechar, true);
  }, [inicioAberto, consultaAberta]);

  const escolher = useCallback(
    (c: CandidatoDeMencao) => {
      if (!gatilho) return;
      const mencao = paraMencao(c);
      const nome = mencao.tipo === "todos" ? c.nome : mencao.nome;
      const novo = aplicarMencao(texto, gatilho, cursor, nome);
      setTexto(novo.texto);
      setCursor(novo.cursor);
      setIndice(0);
      setDispensado({ inicio: gatilho.inicio, consulta: `${nome} ` });
      setEscolhidas((atual) =>
        atual.some((m) => chaveDaMencao(m) === chaveDaMencao(mencao)) ? atual : [...atual, mencao],
      );
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.selectionStart = ta.selectionEnd = novo.cursor;
        aoInserir?.();
      });
    },
    [gatilho, paraMencao, texto, cursor, setTexto, taRef, aoInserir],
  );

  /** `true` quando a tecla foi da lista — o campo não deve tratá-la de novo. */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!aberto) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndice((ativo + 1) % itens.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndice((ativo - 1 + itens.length) % itens.length);
        return true;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        const c = itens[ativo];
        if (c) escolher(c);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (gatilho) setDispensado({ inicio: gatilho.inicio, consulta: gatilho.consulta });
        return true;
      }
      return false;
    },
    [aberto, ativo, itens, escolher, gatilho],
  );

  const onChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      setTexto(e.target.value);
      setCursor(e.target.selectionStart ?? e.target.value.length);
      setIndice(0);
    },
    [setTexto],
  );

  const onSelect = useCallback((e: SyntheticEvent<HTMLTextAreaElement>) => {
    setCursor(e.currentTarget.selectionStart ?? 0);
  }, []);

  /** As marcações que vão com a mensagem: só as que o texto AINDA cita. */
  const paraEnviar = useCallback(
    (textoFinal: string): Mencao[] => mencoesQueSobraram(textoFinal, escolhidas),
    [escolhidas],
  );

  const limpar = useCallback(() => {
    setEscolhidas([]);
    setDispensado(null);
    setIndice(0);
  }, []);

  /** O envio falhou e o texto voltou ao campo: as marcações dele voltam junto. */
  const restaurar = useCallback((mencoes: ReadonlyArray<Mencao>) => {
    setEscolhidas([...mencoes]);
  }, []);

  return {
    aberto,
    itens,
    ativo,
    escolher,
    onKeyDown,
    onChange,
    onSelect,
    onHover: setIndice,
    paraEnviar,
    limpar,
    restaurar,
  };
}
