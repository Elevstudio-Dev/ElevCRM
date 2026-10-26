"use client";

import { useT } from "@/hooks/i18n/useT";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import type { ModeloParaEscolher } from "@/lib/agenda/lembrete/modelo-do-tipo";
import { LOCAIS_DE_ATENDIMENTO } from "@/lib/agenda/locais";
import { apiClient } from "@/lib/api/client";

export interface TipoRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  duration_minutes: number;
  location_kind: string;
  location_details: string | null;
  default_owner_user_id: string | null;
  requires_confirmation: boolean;
  is_active: boolean;
  reminder_enabled: boolean;
  reminder_minutes_before: number;
  reminder_template_name: string | null;
}

/**
 * Com quanta antecedência o lembrete pode sair. Cinco opções fechadas, e não um campo
 * numérico, porque a pergunta que a clínica faz é "um dia antes ou na véspera à noite?",
 * não "quantos minutos?". O piso de 2 h respeita a regra do cron (menos de 1 h de folga
 * é "tarde demais").
 */
const ANTECEDENCIAS_DO_LEMBRETE: Array<{ minutos: number; rotulo: string }> = [
  { minutos: 120, rotulo: "2 horas antes" },
  { minutos: 240, rotulo: "4 horas antes" },
  { minutos: 1440, rotulo: "1 dia antes" },
  { minutos: 2880, rotulo: "2 dias antes" },
  { minutos: 4320, rotulo: "3 dias antes" },
];

/** O rótulo de uma antecedência; valor fora da lista (gravado por API) ainda aparece, em horas. */
function rotuloDaAntecedencia(minutos: number): string {
  return (
    ANTECEDENCIAS_DO_LEMBRETE.find((a) => a.minutos === minutos)?.rotulo ??
    `${Math.round(minutos / 60)} horas antes`
  );
}

/**
 * As dez do CHECK da tabela, com o nome que o dono do negócio usa.
 *
 * ⚠️ O VALOR é o do banco e o RÓTULO é da tela — e os dois não se misturam. A
 * tabela guarda `reuniao` sem acento porque é chave; quem lê vê "Reunião". Se o
 * rótulo virasse valor, o CHECK recusaria e a recusa apareceria como erro
 * interno para quem está usando.
 */
const CATEGORIAS: Array<{ valor: string; rotulo: string }> = [
  { valor: "consulta", rotulo: "Consulta" },
  { valor: "procedimento", rotulo: "Procedimento" },
  { valor: "retorno", rotulo: "Retorno" },
  { valor: "visita", rotulo: "Visita" },
  { valor: "vistoria", rotulo: "Vistoria" },
  { valor: "reuniao", rotulo: "Reunião" },
  { valor: "call", rotulo: "Call" },
  { valor: "orcamento", rotulo: "Orçamento" },
  { valor: "demonstracao", rotulo: "Demonstração" },
  { valor: "outro", rotulo: "Outro" },
];

// Fonte única: a tela que MARCA precisa do mesmo vocabulário, e copiá-lo para lá
// faria uma das duas mostrar o código cru no dia em que um valor entrasse no
// CHECK do banco. Ver o cabeçalho de `lib/agenda/locais.ts`.
const LOCAIS = LOCAIS_DE_ATENDIMENTO;

const rotuloDe = (lista: ReadonlyArray<{ valor: string; rotulo: string }>, valor: string) =>
  lista.find((c) => c.valor === valor)?.rotulo ?? valor;

interface Rascunho {
  name: string;
  category: string;
  duration_minutes: number;
  location_kind: string;
  default_owner_user_id: string;
}

const VAZIO: Rascunho = {
  name: "",
  category: "consulta",
  duration_minutes: 30,
  location_kind: "in_person",
  default_owner_user_id: "",
};

export function TiposDeAgendamentoClient({
  tiposIniciais,
  pessoas,
  podeEditar,
  usuarioAtualId,
  modelos,
  canalExigeModelo,
}: {
  tiposIniciais: TipoRow[];
  pessoas: Array<{ id: string; papel: string; nome: string }>;
  podeEditar: boolean;
  usuarioAtualId: string;
  /** Os modelos aprovados da organização, já avaliados: `serve` diz se o lembrete sabe preenchê-los. */
  modelos: ModeloParaEscolher[];
  /** O canal desta organização só entrega fora das 24 h com modelo aprovado. */
  canalExigeModelo: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [criando, setCriando] = React.useState(false);
  /**
   * O RASCUNHO NASCE COM QUEM ESTÁ CRIANDO.
   *
   * O tipo nascia sem dono por padrão DA PRÓPRIA TELA: `VAZIO` trazia
   * `default_owner_user_id: ""`, o POST omitia o campo, a coluna não tem default
   * no banco — e a lista passava a acusar "sem responsável — não aparece para
   * marcar", um estado que a tela mesma fabricou. Foi assim que "Call
   * Estratégica" nasceu inútil na instalação do dono do produto.
   *
   * A migration 0195 não alcança este caso por construção: o trigger dela é
   * `after insert on user_organizations`, guardado ao PRIMEIRO membro ativo. Ele
   * dispara quando entra MEMBRO, nunca quando entra TIPO — e a org do dono já
   * tinha membro havia tempo.
   *
   * O default vive AQUI e não no POST de propósito: forçar o criador na rota
   * transformaria "Definir depois" num controle decorativo, e deixar um tipo sem
   * dono continua sendo escolha legítima de quem opera.
   */
  const [rascunho, setRascunho] = React.useState<Rascunho>(() => ({
    ...VAZIO,
    default_owner_user_id: usuarioAtualId,
  }));
  const [salvando, setSalvando] = React.useState(false);
  const [editandoId, setEditandoId] = React.useState<string | null>(null);

  async function comErro(acao: () => Promise<unknown>, mensagem: string) {
    setSalvando(true);
    try {
      await acao();
      toast.success(mensagem);
      // `refresh` e não estado local: quem sabe o que ficou gravado é o servidor.
      router.refresh();
      return true;
    } catch (err) {
      showApiError(err);
      return false;
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="tipos-de-agendamento-config">
      {podeEditar ? (
        <div>
          {criando ? (
            <form
              data-testid="form-novo-tipo"
              className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const feito = await comErro(
                  () =>
                    apiClient.post("/api/v1/agenda/tipos", {
                      name: rascunho.name.trim(),
                      category: rascunho.category,
                      duration_minutes: Number(rascunho.duration_minutes),
                      location_kind: rascunho.location_kind,
                      ...(rascunho.default_owner_user_id
                        ? { default_owner_user_id: rascunho.default_owner_user_id }
                        : {}),
                    }),
                  t("Tipo de agendamento criado."),
                );
                if (feito) {
                  setCriando(false);
                  setRascunho(VAZIO);
                }
              }}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                {t("Nome")}
                <input
                  data-testid="novo-tipo-nome"
                  required
                  minLength={2}
                  value={rascunho.name}
                  onChange={(e) => setRascunho((r) => ({ ...r, name: e.target.value }))}
                  placeholder={t("Retorno")}
                  className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text outline-hidden focus:border-border-strong"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                {t("Categoria")}
                <select
                  data-testid="novo-tipo-categoria"
                  value={rascunho.category}
                  onChange={(e) => setRascunho((r) => ({ ...r, category: e.target.value }))}
                  className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text outline-hidden focus:border-border-strong"
                >
                  {CATEGORIAS.map((c) => (
                    <option key={c.valor} value={c.valor}>
                      {t(c.rotulo)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                {t("Duração (minutos)")}
                <input
                  data-testid="novo-tipo-duracao"
                  type="number"
                  min={5}
                  max={1440}
                  value={rascunho.duration_minutes}
                  onChange={(e) =>
                    setRascunho((r) => ({ ...r, duration_minutes: Number(e.target.value) }))
                  }
                  className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text outline-hidden focus:border-border-strong"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                {t("Onde acontece")}
                <select
                  data-testid="novo-tipo-local"
                  value={rascunho.location_kind}
                  onChange={(e) => setRascunho((r) => ({ ...r, location_kind: e.target.value }))}
                  className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text outline-hidden focus:border-border-strong"
                >
                  {LOCAIS.map((l) => (
                    <option key={l.valor} value={l.valor}>
                      {l.rotulo}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted sm:col-span-2">
                {/* ⚠️ SEM RESPONSÁVEL NÃO HÁ AGENDA. `lib/agenda/consulta.ts` exige
                    dono para saber de QUEM é a jornada; sem ele a rota devolve
                    `sem_responsavel` e a tela de marcar não oferece horário nenhum.
                    Era exatamente o estado dos três tipos semeados. */}
                {t("Quem atende (sem isto, não há horário para oferecer)")}
                <select
                  data-testid="novo-tipo-dono"
                  value={rascunho.default_owner_user_id}
                  onChange={(e) =>
                    setRascunho((r) => ({ ...r, default_owner_user_id: e.target.value }))
                  }
                  className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text outline-hidden focus:border-border-strong"
                >
                  <option value="">{t("Definir depois")}</option>
                  {pessoas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nome}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setCriando(false)}>
                  Cancelar
                </Button>
                <Button type="submit" size="sm" data-testid="salvar-novo-tipo" disabled={salvando}>
                  {salvando ? t("Criando…") : t("Criar tipo")}
                </Button>
              </div>
            </form>
          ) : (
            <Button size="sm" data-testid="abrir-novo-tipo" onClick={() => setCriando(true)}>
              Novo tipo de agendamento
            </Button>
          )}
        </div>
      ) : null}

      <ul className="flex flex-col gap-2" data-testid="lista-de-tipos">
        {tiposIniciais.length === 0 ? (
          <li data-testid="sem-tipos" className="rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
            {t("Nenhum tipo de agendamento ainda. Crie o primeiro para que a Agenda tenha o que oferecer.")}
          </li>
        ) : null}
        {tiposIniciais.map((tipo) => (
          <li
            key={tipo.id}
            data-testid={`tipo-${tipo.id}`}
            className={`rounded-lg border border-border bg-surface p-3 ${tipo.is_active ? "" : "opacity-60"}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-text">{t(tipo.name)}</span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-muted">
                {rotuloDe(CATEGORIAS, tipo.category)}
              </span>
              <span className="text-xs tabular-nums text-text-muted">{tipo.duration_minutes} min</span>
              <span className="text-xs text-text-muted">{rotuloDe(LOCAIS, tipo.location_kind)}</span>
              {!tipo.default_owner_user_id ? (
                // O aviso existe porque o sintoma é MUDO: sem dono, a tela de
                // marcar simplesmente não mostra horário, sem dizer por quê.
                //
                // E ele É A PORTA quando há como resolver. Antes era um `<span>`
                // inerte: acusava o estado e a única saída era descobrir sozinho
                // que o botão "Editar" abre um seletor de responsável. Acusar sem
                // oferecer caminho é o mesmo defeito do aviso da Agenda que não
                // levava aos horários — dito duas vezes no mesmo produto.
                //
                // Mesmo `data-testid` nos dois ramos: ele é contrato de quem lê a
                // tela, e trocá-lo faria a cerca existente parar de encontrar o
                // aviso sem nada acusar.
                podeEditar ? (
                  <button
                    type="button"
                    data-testid={`sem-dono-${tipo.id}`}
                    onClick={() => setEditandoId(tipo.id)}
                    className="text-xs text-warning underline underline-offset-2"
                  >
                    {t("sem responsável — definir quem atende")}
                  </button>
                ) : (
                  <span data-testid={`sem-dono-${tipo.id}`} className="text-xs text-warning">
                    {t("sem responsável — não aparece para marcar")}
                  </span>
                )
              ) : null}
              {tipo.reminder_enabled ? (
                <span
                  data-testid={`lembrete-${tipo.id}`}
                  className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-muted"
                >
                  {t("Lembrete")} {t(rotuloDaAntecedencia(tipo.reminder_minutes_before))}
                </span>
              ) : null}
              {tipo.reminder_enabled && canalExigeModelo && !tipo.reminder_template_name ? (
                // O aviso existe porque o sintoma é MUDO: o canal oficial só entrega fora
                // das 24 h com modelo aprovado, e sem ele o lembrete fica esperando até
                // vencer — o paciente não recebe e ninguém vê erro nenhum na tela.
                // E ele é a porta: abre a edição, onde o modelo se escolhe.
                podeEditar ? (
                  <button
                    type="button"
                    data-testid={`lembrete-sem-modelo-${tipo.id}`}
                    onClick={() => setEditandoId(tipo.id)}
                    className="text-xs text-warning underline underline-offset-2"
                  >
                    {t("lembrete sem modelo aprovado — escolher modelo")}
                  </button>
                ) : (
                  <span data-testid={`lembrete-sem-modelo-${tipo.id}`} className="text-xs text-warning">
                    {t("lembrete sem modelo aprovado — o aviso pode não sair")}
                  </span>
                )
              ) : null}
              {!tipo.is_active ? <span className="text-xs text-text-subtle">{t("desativado")}</span> : null}
              {podeEditar ? (
                <span className="ml-auto flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`editar-${tipo.id}`}
                    onClick={() => setEditandoId(editandoId === tipo.id ? null : tipo.id)}
                  >
                    {editandoId === tipo.id ? t("Fechar") : t("Editar")}
                  </Button>
                  {tipo.is_active ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`desativar-${tipo.id}`}
                      disabled={salvando}
                      onClick={() =>
                        void comErro(
                          () => apiClient.delete("/api/v1/agenda/tipos", { id: tipo.id }),
                          "Tipo desativado.",
                        )
                      }
                    >
                      Desativar
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`reativar-${tipo.id}`}
                      disabled={salvando}
                      onClick={() =>
                        void comErro(
                          () => apiClient.patch("/api/v1/agenda/tipos", { id: tipo.id, is_active: true } as never),
                          "Tipo reativado.",
                        )
                      }
                    >
                      Reativar
                    </Button>
                  )}
                </span>
              ) : null}
            </div>

            {editandoId === tipo.id ? (
              <form
                data-testid={`form-editar-${tipo.id}`}
                className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const dados = new FormData(e.currentTarget);
                  const feito = await comErro(
                    () =>
                      apiClient.patch("/api/v1/agenda/tipos", {
                        id: tipo.id,
                        name: String(dados.get("name") ?? "").trim(),
                        category: String(dados.get("category") ?? tipo.category),
                        duration_minutes: Number(dados.get("duration_minutes") ?? tipo.duration_minutes),
                        // `|| null`, e NÃO omitir quando vazio.
                        //
                        // A tela oferece `<option value="">{t("Sem responsável")}</option>`
                        // logo abaixo, e omitir o campo fazia essa escolha não
                        // chegar ao servidor: depois de definido, o responsável não
                        // podia mais ser removido. Controle que a tela oferece e o
                        // código ignora é o pior dos dois — pior que não existir,
                        // porque quem clica conclui que salvou.
                        //
                        // `alterarSchema` aceita `nullish()`, então o nulo é
                        // contrato, não contorno. O efeito de limpar é a agenda
                        // daquele tipo parar de oferecer horário e o aviso amarelo
                        // voltar — que é o laço de retorno correto.
                        default_owner_user_id:
                          String(dados.get("default_owner_user_id") ?? "") || null,
                        // O checkbox desmarcado NÃO vem no FormData: ausente é "desligado",
                        // e é por isso que a leitura é `=== "on"` e não `Boolean(get)`.
                        reminder_enabled: dados.get("reminder_enabled") === "on",
                        reminder_minutes_before: Number(
                          dados.get("reminder_minutes_before") ?? tipo.reminder_minutes_before,
                        ),
                        // `|| null`: "Texto padrão" é o valor vazio, e voltar a ele tem de
                        // chegar ao servidor como nulo, não como campo ausente.
                        reminder_template_name:
                          String(dados.get("reminder_template_name") ?? "") || null,
                      }),
                    "Tipo alterado.",
                  );
                  if (feito) setEditandoId(null);
                }}
              >
                <label className="flex flex-col gap-1 text-xs text-text-muted">
                  Nome
                  <input
                    name="name"
                    defaultValue={tipo.name}
                    data-testid={`editar-nome-${tipo.id}`}
                    className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-text-muted">
                  {t("Duração")}
                  <input
                    name="duration_minutes"
                    type="number"
                    min={5}
                    max={1440}
                    defaultValue={tipo.duration_minutes}
                    data-testid={`editar-duracao-${tipo.id}`}
                    className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-text-muted">
                  {t("Quem atende")}
                  <select
                    name="default_owner_user_id"
                    defaultValue={tipo.default_owner_user_id ?? ""}
                    data-testid={`editar-dono-${tipo.id}`}
                    className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
                  >
                    <option value="">{t("Sem responsável")}</option>
                    {pessoas.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nome}
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset
                  data-testid={`lembrete-config-${tipo.id}`}
                  className="grid gap-3 rounded-md border border-border p-3 sm:col-span-3 sm:grid-cols-3"
                >
                  <legend className="px-1 text-xs font-medium text-text-muted">
                    {t("Lembrete por WhatsApp")}
                  </legend>
                  <label className="flex items-center gap-2 text-sm text-text sm:col-span-3">
                    <input
                      type="checkbox"
                      name="reminder_enabled"
                      defaultChecked={tipo.reminder_enabled}
                      data-testid={`editar-lembrete-ligado-${tipo.id}`}
                    />
                    {t("Avisar o paciente antes do atendimento")}
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-text-muted">
                    {t("Quanto tempo antes")}
                    <select
                      name="reminder_minutes_before"
                      defaultValue={tipo.reminder_minutes_before}
                      data-testid={`editar-lembrete-antecedencia-${tipo.id}`}
                      className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
                    >
                      {!ANTECEDENCIAS_DO_LEMBRETE.some((a) => a.minutos === tipo.reminder_minutes_before) ? (
                        <option value={tipo.reminder_minutes_before}>
                          {t(rotuloDaAntecedencia(tipo.reminder_minutes_before))}
                        </option>
                      ) : null}
                      {ANTECEDENCIAS_DO_LEMBRETE.map((a) => (
                        <option key={a.minutos} value={a.minutos}>
                          {t(a.rotulo)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-text-muted sm:col-span-2">
                    {t("Modelo de mensagem")}
                    <select
                      name="reminder_template_name"
                      defaultValue={tipo.reminder_template_name ?? ""}
                      data-testid={`editar-lembrete-modelo-${tipo.id}`}
                      className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
                    >
                      <option value="">{t("Texto padrão (só onde o canal aceita texto livre)")}</option>
                      {modelos.map((m) => (
                        // Modelo que o lembrete não sabe preencher aparece DESABILITADO e
                        // com o motivo, em vez de sumir: quem criou o modelo na Meta
                        // procura por ele, e some-sem-explicar é o defeito de sempre.
                        <option key={m.nome} value={m.nome} disabled={!m.serve}>
                          {m.serve ? m.nome : `${m.nome} — ${t("não serve")}: ${m.problema ?? ""}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-xs text-text-muted sm:col-span-3">
                    {t("No canal oficial do WhatsApp, o aviso fora das 24 h só sai com um modelo aprovado pela Meta, com as variáveis nome, data, hora, servico, profissional e local. Crie e aprove o modelo em Conexões → Oficial → Templates.")}
                  </p>
                </fieldset>
                <div className="flex justify-end sm:col-span-3">
                  <Button type="submit" size="sm" data-testid={`salvar-${tipo.id}`} disabled={salvando}>
                    {salvando ? t("Salvando…") : t("Salvar")}
                  </Button>
                </div>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
