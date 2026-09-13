# O GitHub App de release — como ele existe, e como se ensaia

> Estado medido em 2026-09-12: o App **`elevcrm-release`** (App ID `4914675`)
> existe na conta Elevstudio-Dev, está instalado só em `ElevCRM` (instalação
> `161026683`), e `gh secret list --repo Elevstudio-Dev/ElevCRM` lista
> `RELEASE_APP_ID` e `RELEASE_APP_PRIVATE_KEY`. **O ciclo inteiro foi ensaiado
> em 2026-09-12:** o [PR #2 — Release 1.16.0](https://github.com/Elevstudio-Dev/ElevCRM/pull/2)
> nasceu do bot, o merge criou a tag `v1.16.0` e o
> [release](https://github.com/Elevstudio-Dev/ElevCRM/releases/tag/v1.16.0), e
> as três imagens saíram em `ghcr.io/elevstudio-dev/{elevcrm,elevcrm-worker,elevcrm-scheduler}`
> com `1.16.0`, `1.16` e `stable` (mesmo digest; conferido por
> `docker manifest inspect`). **Distribuir já é possível.** A seção "O que
> criar" abaixo fica como registro de como se cria de novo (chave perdida,
> conta nova).

## Por que um App, e não o token do próprio workflow

Evento disparado com o `GITHUB_TOKEN` **não cria novo workflow run** (regra do
GitHub). Se a tag `vX.Y.Z` nascesse dele, o `publish-image.yml` jamais rodaria:
a tag existiria, ninguém veria erro, e nenhuma VPS receberia a atualização. O
App é o que faz a tag "contar" como evento de gente.

Medido no ensaio: o PR aberto pelo token do App disparou sozinho `ci`, `e2e`,
`perf` e o smoke do `publish-image` — a prova de que a tag, quando nascer do
mesmo token, acorda o `publish-image.yml`.

## O que criar (uma vez, ~10 minutos)

1. **Criar o App** em GitHub → *Settings* → *Developer settings* → *GitHub Apps*
   → *New GitHub App*, na conta **Elevstudio-Dev** (a dona do repositório).
   - **Nome:** `elevcrm-release` — exatamente. O bot aparece como
     `elevcrm-release[bot]`, e a guarda `tests/unit/tag-so-nasce-da-main.test.ts`
     exige esse nome nas tags.
   - **Homepage URL:** `https://github.com/Elevstudio-Dev/ElevCRM`.
   - **Webhook:** desmarque *Active* (não usamos).
   - **Repository permissions:** *Contents* → **Read and write** (branch, tag e
     release); *Pull requests* → **Read and write** (o PR de release);
     *Metadata* → Read (vem marcado).
   - **Where can this app be installed:** *Only on this account*.
   - O GitHub pede *sudo mode* (confirmação por e-mail) antes de abrir o
     formulário. É ação de quem é dono da conta.
2. **Gerar a chave privada:** na página do App, *Private keys* → *Generate a
   private key*. Baixa um `.pem`. **Guarde-o fora do repositório** e não o cole
   em chat nenhum. **A instalação (passo 3) só é liberada depois deste passo** —
   o GitHub avisa no topo da página.
   - Nesta máquina o Chrome baixa em `D:\Usuario\Downloads`, não em
     `C:\Users\dudu8\Downloads`. Procurar pelo nome
     (`elevcrm-release.AAAA-MM-DD.private-key.pem`) antes de supor a pasta.
3. **Instalar o App no repositório:** *Install App* → Elevstudio-Dev → *Only
   select repositories* → `ElevCRM`.
4. **Gravar os dois secrets.** O App ID (número, página *General* do App)
   não é segredo e pode ir pela linha de comando; a chave vai direto do
   arquivo para o `gh`, sem passar por tela:

   ```bash
   gh secret set RELEASE_APP_ID --repo Elevstudio-Dev/ElevCRM --body 4914675
   gh secret set RELEASE_APP_PRIVATE_KEY --repo Elevstudio-Dev/ElevCRM < /mnt/d/Usuario/Downloads/elevcrm-release.AAAA-MM-DD.private-key.pem
   ```

   O workflow lê esse valor pelo input `client-id` da action (o `app-id`
   está depreciado), e o input aceita App ID ou Client ID. **Fique no App
   ID:** ele sai de `gh api` e de qualquer log; o Client ID (`Iv23…`) só
   aparece na página de configurações, atrás do *sudo mode*, e em
   2026-09-13 um Client ID copiado de screenshot (`l` × `I`) deu
   `Integration not found` e derrubou o `cortar-tag` de um push.

   O script `C:\Users\dudu8\elev-gravar-chave.sh` faz o segundo comando com o
   caminho já preenchido: `wsl -- bash /mnt/c/Users/dudu8/elev-gravar-chave.sh`.
   **Não** rode o comando cru no Prompt de Comando: o `cmd.exe` engole o `<` e
   o `|` antes de entregar ao WSL e responde "O sistema não pode encontrar o
   arquivo especificado" — a chave nunca chega ao `gh`. O script existe por isso.
5. **Reativar o workflow `release`** se ele estiver `disabled_manually` (foi
   desligado à mão enquanto não havia App, para não falhar a cada push):

   ```bash
   gh workflow list --repo Elevstudio-Dev/ElevCRM --all
   gh workflow enable release.yml --repo Elevstudio-Dev/ElevCRM
   ```

Conferir, sem expor nada:

```bash
gh secret list --repo Elevstudio-Dev/ElevCRM
```

Deve listar os dois nomes (nunca os valores).

## O ensaio, antes de qualquer VPS

Com os secrets no lugar, o ciclo inteiro pode ser ensaiado sem cliente nenhum:

1. *Actions* → *release* → *Run workflow* (ou
   `gh workflow run release.yml --repo Elevstudio-Dev/ElevCRM --ref main`). Ele
   lê `.changes/`, calcula o número e abre um PR de release em português.
   **Nada é publicado neste ato.**
2. Fazer merge do PR. Ele cria a tag, o `publish-image.yml` publica
   `ghcr.io/elevstudio-dev/elevcrm`, `elevcrm-worker` e `elevcrm-scheduler`, e
   o próprio release confere as três no registro — **falha alto** se não
   aparecerem.

Só depois disso vale instalar a VPS: instalar antes é descobrir na casa do
cliente que a imagem não existe.

### O que o primeiro ensaio (2026-09-12) ensinou

- **A E2E da `main` estava vermelha desde 08/09** e ninguém tinha olhado: o PR
  de release foi o primeiro lugar onde os checks ficaram à vista. Um deles
  (`j20.18`) veio do merge do upstream; os outros eram nossos, nascidos no
  `fix(shell)` do dia anterior. Regra que fica: **antes de disparar o ato 1,
  conferir `gh run list --workflow e2e --branch main --limit 3`**. O PR de
  release não é o lugar de descobrir vermelho.
- **`app-id` estava depreciado** no `actions/create-github-app-token@v3`
  ("Use 'client-id' instead") — trocado em 2026-09-13 pelo input `client-id`,
  nos dois jobs, lendo o mesmo `RELEASE_APP_ID`. A guarda
  `tag-so-nasce-da-main` reprova se `app-id` voltar. Todo push na `main`
  prova o token (é o primeiro passo do `cortar-tag`); se ele falhar com
  `Integration not found`, o valor do secret está errado.
- **O número da versão colide com o upstream.** O CHANGELOG anuncia `1.15.0`
  porque o merge de setembro trouxe a release *deles*; nossa última tag é
  `v1.14.0`, e a próxima sai `v1.16.0` — número que o upstream também tem, com
  outro conteúdo. Ver a decisão em
  [levantamentos/2026-09-11-upstream.md](levantamentos/2026-09-11-upstream.md).

## O que NÃO fazer

- Não usar um *personal access token* no lugar do App. Funciona, mas prende a
  distribuição inteira à conta pessoal de uma pessoa — e ao dia em que ela sair.
- Não commitar o `.pem`. O `.gitignore` não protege contra `git add` de um
  arquivo com outro nome.
- Não editar o número no PR de release. Se estiver errado, **feche o PR**,
  corrija o fragmento e dispare o workflow de novo — é o que o corpo do PR diz.
