/**
 * O DIA E A HORA QUE A PESSOA ESCOLHEU → O INSTANTE ABSOLUTO QUE O SERVIDOR RECEBE.
 *
 * O formulário tem dois campos (`<input type="date">` e `<input type="time">`), que o navegador entrega no FUSO DA
 * PESSOA. O servidor só aceita instante absoluto (ISO 8601): "amanhã" lido dias depois não significa nada. Esta
 * conversão fica fora do componente para ser testada sem montar tela — é aqui que "9h" vira o instante certo.
 *
 * Puro: o "agora" entra por parâmetro.
 */

const DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
const HORA = /^(\d{2}):(\d{2})$/;

/** Hora padrão de um retorno marcado só por dia: começo do expediente. */
export const HORA_PADRAO_DO_RETORNO = "09:00";

function doisDigitos(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD` no fuso local de `data`. */
export function diaLocal(data: Date): string {
  return `${data.getFullYear()}-${doisDigitos(data.getMonth() + 1)}-${doisDigitos(data.getDate())}`;
}

/** O dia daqui a `dias` dias, no fuso local, como `YYYY-MM-DD`. */
export function diaDaquiA(agora: Date, dias: number): string {
  const d = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + dias);
  return diaLocal(d);
}

/**
 * Dia + hora (fuso local) → `Date`. `null` para qualquer coisa que não seja uma data real: "2026-02-31" não existe e
 * o `Date` do JavaScript a empurraria em silêncio para março, marcando o retorno no dia errado.
 */
export function instanteDoRetorno(dia: string, hora: string): Date | null {
  const d = DIA.exec(dia);
  const h = HORA.exec(hora);
  if (!d || !h) return null;
  const [ano, mes, diaDoMes] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [horas, minutos] = [Number(h[1]), Number(h[2])];
  const data = new Date(ano, mes - 1, diaDoMes, horas, minutos, 0, 0);
  if (
    data.getFullYear() !== ano ||
    data.getMonth() !== mes - 1 ||
    data.getDate() !== diaDoMes ||
    data.getHours() !== horas ||
    data.getMinutes() !== minutos
  ) {
    return null;
  }
  return data;
}
