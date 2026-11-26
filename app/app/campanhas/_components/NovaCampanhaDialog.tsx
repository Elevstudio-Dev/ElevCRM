"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useCriarCampanha,
  useOpcoesDaCampanha,
  usePreviaDaCampanha,
} from "@/hooks/campanhas/useCampanhas";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { RITMO_PADRAO, ritmoDaCampanhaSchema, type RitmoDaCampanha } from "@/lib/campanhas/horarios";
import { STATUS_DE_CANAL_PARADO } from "@/lib/campanhas/parametros";
import { cn } from "@/lib/utils";

import { dataHora } from "./rotulos";

const DIAS = [
  { n: 0, rotulo: "Dom" },
  { n: 1, rotulo: "Seg" },
  { n: 2, rotulo: "Ter" },
  { n: 3, rotulo: "Qua" },
  { n: 4, rotulo: "Qui" },
  { n: 5, rotulo: "Sex" },
  { n: 6, rotulo: "Sáb" },
];

/** Espera o usuário parar de digitar antes de pedir a prévia de novo. */
function useAtrasado<T>(valor: T, ms: number): T {
  const [atrasado, setAtrasado] = useState(valor);
  useEffect(() => {
    const id = setTimeout(() => setAtrasado(valor), ms);
    return () => clearTimeout(id);
  }, [valor, ms]);
  return atrasado;
}

function NumeroCampo(props: { id: string; rotulo: string; valor: number; onChange: (n: number) => void; min: number; max: number }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={props.id} className="text-xs text-muted-foreground">
        {props.rotulo}
      </Label>
      <Input
        id={props.id}
        type="number"
        inputMode="numeric"
        min={props.min}
        max={props.max}
        value={Number.isFinite(props.valor) ? props.valor : ""}
        onChange={(e) => props.onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        className="h-9 tabular-nums"
      />
    </div>
  );
}

export function NovaCampanhaDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const router = useRouter();
  const opcoes = useOpcoesDaCampanha(open);
  const criar = useCriarCampanha();

  const [nome, setNome] = useState("");
  const [etiquetas, setEtiquetas] = useState<string[]>([]);
  const [busca, setBusca] = useState("");
  const [canalId, setCanalId] = useState("");
  const [objetivo, setObjetivo] = useState("");
  const [ritmo, setRitmo] = useState<RitmoDaCampanha>(RITMO_PADRAO);

  const ritmoValido = ritmoDaCampanhaSchema.safeParse(ritmo).success;
  // Texto, e não objeto: um objeto novo a cada render reiniciaria o atraso para sempre.
  const previaChave = useAtrasado(JSON.stringify({ etiquetas, ritmo: ritmoValido ? ritmo : null }), 400);
  const previaPedido = useMemo(
    () => JSON.parse(previaChave) as { etiquetas: string[]; ritmo: RitmoDaCampanha | null },
    [previaChave],
  );
  const previa = usePreviaDaCampanha(previaPedido.etiquetas, previaPedido.ritmo, open);

  const etiquetasVisiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const todas = opcoes.data?.etiquetas ?? [];
    return q ? todas.filter((e) => e.etiqueta.toLowerCase().includes(q)) : todas;
  }, [busca, opcoes.data]);

  function alternarEtiqueta(e: string) {
    setEtiquetas((atual) => (atual.includes(e) ? atual.filter((x) => x !== e) : [...atual, e].slice(0, 10)));
  }

  function alternarDia(n: number) {
    setRitmo((r) => ({
      ...r,
      dias: r.dias.includes(n) ? r.dias.filter((d) => d !== n) : [...r.dias, n].sort(),
    }));
  }

  function limpar() {
    setNome("");
    setEtiquetas([]);
    setBusca("");
    setCanalId("");
    setObjetivo("");
    setRitmo(RITMO_PADRAO);
  }

  const recebem = previa.data?.recebem ?? 0;
  const podeCriar =
    nome.trim().length > 0 &&
    etiquetas.length > 0 &&
    canalId !== "" &&
    objetivo.trim().length >= 10 &&
    ritmoValido &&
    recebem > 0 &&
    !criar.isPending;

  async function confirmar() {
    const criada = await criar.mutateAsync({
      nome: nome.trim(),
      etiquetas,
      canal_id: canalId,
      objetivo: objetivo.trim(),
      ritmo,
    });
    limpar();
    onOpenChange(false);
    router.push(`/app/campanhas/${criada.id}`);
  }

  const fora = previa.data?.fora;
  const motivosDeFora = fora
    ? [
        { n: fora.pediu_para_sair, texto: t("pediram para não receber") },
        { n: fora.telefone_fixo, texto: t("telefone fixo") },
        { n: fora.sem_telefone, texto: t("sem celular válido") },
        { n: fora.em_outro_followup, texto: t("já estão em outro follow-up") },
        { n: fora.equipe, texto: t("são da equipe") },
        { n: fora.anonimizado, texto: t("anonimizados") },
      ].filter((m) => m.n > 0)
    : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) limpar();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Nova campanha")}</DialogTitle>
          <DialogDescription>
            {t("A IA escreve uma mensagem diferente para cada pessoa, com o nome e o tratamento dela. Quem responder cai na conversa normal; quem responder PARAR não recebe mais nada.")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="campanha-nome">{t("Nome da campanha")}</Label>
            <Input
              id="campanha-nome"
              value={nome}
              maxLength={60}
              onChange={(e) => setNome(e.target.value)}
              placeholder={t("Ex.: Revisão de limpeza — base antiga")}
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("Quem recebe")}</legend>
            <p className="text-xs text-muted-foreground">
              {t("Recebe quem tiver TODAS as etiquetas escolhidas.")}
            </p>
            {etiquetas.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {etiquetas.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => alternarEtiqueta(e)}
                    className="rounded-full border border-accent bg-accent-soft px-2.5 py-0.5 text-xs text-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`${t("Tirar")} ${e}`}
                  >
                    {e} ×
                  </button>
                ))}
              </div>
            ) : null}
            <Input
              type="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={t("Buscar etiqueta…")}
              className="h-9"
            />
            <div className="max-h-44 overflow-y-auto rounded-md border border-border">
              {opcoes.isLoading ? (
                <p className="p-3 text-sm text-muted-foreground">{t("Carregando…")}</p>
              ) : etiquetasVisiveis.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">{t("Nenhuma etiqueta encontrada.")}</p>
              ) : (
                <ul>
                  {etiquetasVisiveis.map((e) => {
                    const marcada = etiquetas.includes(e.etiqueta);
                    return (
                      <li key={e.etiqueta}>
                        <button
                          type="button"
                          onClick={() => alternarEtiqueta(e.etiqueta)}
                          aria-pressed={marcada}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-elevated focus-visible:bg-surface-elevated focus-visible:outline-hidden",
                            marcada && "font-medium text-accent",
                          )}
                        >
                          <span className="truncate">{e.etiqueta}</span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{e.contatos}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="campanha-canal">{t("Número de saída")}</Label>
            <Select value={canalId} onValueChange={setCanalId}>
              <SelectTrigger id="campanha-canal">
                <SelectValue placeholder={t("Escolha o número")} />
              </SelectTrigger>
              <SelectContent>
                {(opcoes.data?.canais ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id} disabled={STATUS_DE_CANAL_PARADO.has(c.status)}>
                    {c.nome}
                    {c.telefone ? ` · ${c.telefone}` : ""}
                    {c.status !== "WORKING" ? ` (${t("desconectado")})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("Mandar para muita gente que não fala com a empresa há tempo pode levar o WhatsApp a bloquear o número. Se tiver um segundo número, use-o e deixe o principal só para o atendimento.")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="campanha-objetivo">{t("Objetivo da mensagem")}</Label>
            <Textarea
              id="campanha-objetivo"
              value={objetivo}
              maxLength={800}
              rows={3}
              onChange={(e) => setObjetivo(e.target.value)}
              placeholder={t("Ex.: Convidar para agendar a revisão de limpeza. Lembrar que faz tempo desde o último atendimento. Não oferecer desconto.")}
            />
            <p className="text-xs text-muted-foreground">
              {t("É a orientação que a IA segue. Ela não inventa preço, data nem promoção que não estejam aqui.")}
            </p>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t("Ritmo dos envios")}</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <NumeroCampo
                id="ritmo-dia"
                rotulo={t("Por dia")}
                valor={ritmo.por_dia}
                min={1}
                max={200}
                onChange={(n) => setRitmo((r) => ({ ...r, por_dia: n }))}
              />
              <NumeroCampo
                id="ritmo-min"
                rotulo={t("Intervalo mín. (min)")}
                valor={ritmo.min_minutos}
                min={1}
                max={120}
                onChange={(n) => setRitmo((r) => ({ ...r, min_minutos: n }))}
              />
              <NumeroCampo
                id="ritmo-max"
                rotulo={t("Intervalo máx. (min)")}
                valor={ritmo.max_minutos}
                min={1}
                max={240}
                onChange={(n) => setRitmo((r) => ({ ...r, max_minutos: n }))}
              />
              <NumeroCampo
                id="ritmo-inicio"
                rotulo={t("Das (hora)")}
                valor={ritmo.hora_inicio}
                min={0}
                max={23}
                onChange={(n) => setRitmo((r) => ({ ...r, hora_inicio: n }))}
              />
              <NumeroCampo
                id="ritmo-fim"
                rotulo={t("Até (hora)")}
                valor={ritmo.hora_fim}
                min={1}
                max={24}
                onChange={(n) => setRitmo((r) => ({ ...r, hora_fim: n }))}
              />
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label={t("Dias da semana")}>
              {DIAS.map((d) => {
                const ligado = ritmo.dias.includes(d.n);
                return (
                  <button
                    key={d.n}
                    type="button"
                    aria-pressed={ligado}
                    onClick={() => alternarDia(d.n)}
                    className={cn(
                      "min-w-11 rounded-md border px-2 py-1 text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                      ligado ? "border-accent bg-accent-soft text-accent" : "border-border text-muted-foreground",
                    )}
                  >
                    {t(d.rotulo)}
                  </button>
                );
              })}
            </div>
            {!ritmoValido ? (
              <p className="text-xs text-error-fg">
                {t("Confira o ritmo: o intervalo máximo não pode ser menor que o mínimo, e o fim do horário precisa vir depois do início.")}
              </p>
            ) : null}
          </fieldset>

          <section className="rounded-lg border border-border bg-surface-elevated p-3 text-sm" aria-live="polite">
            {etiquetas.length === 0 ? (
              <p className="text-muted-foreground">{t("Escolha ao menos uma etiqueta para ver quem recebe.")}</p>
            ) : previa.isLoading || previa.isFetching ? (
              <p className="text-muted-foreground">{t("Calculando…")}</p>
            ) : previa.data ? (
              <div className="space-y-1.5">
                <p>
                  <span className="text-lg font-semibold tabular-nums">{previa.data.recebem}</span>{" "}
                  {t("pessoas recebem")}
                  <span className="text-muted-foreground">
                    {" "}
                    ({t("de")} {previa.data.total_com_etiquetas} {t("com as etiquetas")})
                  </span>
                </p>
                {motivosDeFora.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("Ficam de fora")}: {motivosDeFora.map((m) => `${m.n} ${m.texto}`).join(" · ")}
                  </p>
                ) : null}
                {previa.data.primeiro_envio ? (
                  <p className="text-xs text-muted-foreground">
                    {t("Primeiro envio")}: {dataHora(previa.data.primeiro_envio, tagDoIdioma)} · {t("último")}:{" "}
                    {dataHora(previa.data.ultimo_envio, tagDoIdioma)}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">{t("Não foi possível calcular a prévia.")}</p>
            )}
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => void confirmar()} disabled={!podeCriar}>
            {criar.isPending ? t("Agendando…") : `${t("Agendar envios para")} ${recebem}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
