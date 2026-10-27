# Marca Elev Studio no Elev CRM — identidade forte, cor com significado

**Data:** 2026-10-27 · **Branch:** `elev/marca-elev-studio` · **Pedido do Carlos:** "deixe a identidade da
Elev Studio mais forte nesse sistema, para identificarem que é um sistema da Elev Studio mesmo: nosso
ícone e nossas cores, só que mais colorido e visualmente mais fácil de entender".

## Decisões (do Carlos, 27/10)

- **Escopo:** "Marca + cor com significado". Roxo Elev como cor de ação; ícone e login com identidade; status,
  etapas, avatares e etiquetas coloridos **com ícone ou texto junto** (cor nunca é a única informação).
  O tema escuro NÃO vira o padrão.
- **Tipografia:** "que nem a do site elevstudio.com.br": **IBM Plex Sans** nos títulos e na marca,
  **Source Sans 3** no corpo.

## A identidade (lida do site e dos posts, não é palpite)

| Papel | Valor |
|---|---|
| Roxo Elev (ação, marca) | `#67298f` — semente da rampa de 11 tons (o motor de `lib/branding/rampa.ts`) |
| Roxo profundo (destaque, hover) | `#53266c` |
| Claro: fundo / lavado | `#f4f2ef` / `#efe6f5` |
| Escuro: fundo / superfície | `#0a0a0c` / `#151217` (preto com um fio de violeta) |
| Ícone | `elevstudio.com.br/icon.svg` — branco sobre roxo, ou roxo sobre claro |

## O que muda, e por onde

1. **Roxo como cor de ação** — por CONFIGURAÇÃO, não por código: `platform_branding.accent_hex` e
   `APP_ACCENT_HEX`. O motor já deriva os 11 tons nos dois temas com piso de contraste. O `globals.css`
   mantém a Sage do upstream como padrão (o teste de rampa a usa de régua).
2. **Fonte** — `app/layout.tsx` (next/font) e a ponte `--font-*` do `globals.css`.
3. **Neutros do escuro** — de marrom-esverdeado para o preto Elev com violeta; claro vai para o off-white
   `#f4f2ef`. Os três blocos de token (`:root`, `[data-theme="light"]`, `[data-theme="dark"]`) mudam JUNTOS —
   o teste `branding-tema-claro-escopavel` exige.
4. **Cores semânticas mais vivas** (sucesso, atenção, erro, informação) com o contraste da régua do produto.
5. **O ícone** — componente `IconeElev` (SVG inline, `currentColor`), na barra superior, no favicon
   (`app/icon.tsx`), no `apple-icon` e na lateral da tela de entrada.
6. **Tela de entrada** — painel de marca (roxo, grade, ícone, frase) ao lado do formulário em telas largas;
   no celular só o formulário, como hoje. O `data-testid="logo-da-fachada"` e a regra "o logo da empresa não
   vaza para a fachada" ficam como estão.
7. **Cor com significado nas telas** — estado da conversa (quem atende), avatares por contato, etapas do funil
   sem cor própria, etiquetas. Cada uso leva texto ou ícone junto.

## Fora do escopo (dito para não virar surpresa)

- Fonte por organização: continua não sendo configurável (resolve em build).
- E-mails de acesso: ganham a cor pelo `APP_ACCENT_HEX` + `marca-emails.sh` (já existe), sem mudar o texto.
- Imagem de compartilhamento (Open Graph) do produto: fica para depois.

## Como vai ser provado

`pnpm gov:verify` e `pnpm test:shell` verdes; os testes de marca/contraste reprovam se a paleta nova quebrar o
piso; prints reais (claro e escuro) de entrada, Inbox, Funis, Contatos, Agenda e IA, vistos no navegador antes
de qualquer release. Nada sobe para a VPS sem o Carlos ver os prints.
