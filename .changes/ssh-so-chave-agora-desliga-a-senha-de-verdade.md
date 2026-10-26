---
impacto: nada_mudou
secao: corrigido
titulo: O preparar-host.sh --ssh-so-chave agora desliga a senha do SSH de verdade — e confere pelo valor que o servidor usa
---

Na 1.17.0, `preparar-host.sh --ssh-so-chave` dizia "SSH só com chave" mas, em
servidores de nuvem (Hostinger e qualquer imagem com cloud-init),
**a senha continuava ligada**. O servidor lê os arquivos de `/etc/ssh/sshd_config.d/` em
ordem e vale o primeiro valor de cada diretiva; essas imagens trazem um
`50-cloud-init.conf` com `PasswordAuthentication yes`, e o arquivo do kit
(`99-elevcrm.conf`) vinha depois dele e perdia. O script confirmava o sucesso
olhando o arquivo que ele mesmo gravou, e não o que o servidor usa.

Agora o arquivo se chama `00-elevcrm.conf` (vem antes de todos), o script apaga
o `99-elevcrm.conf` que a 1.17.0 deixou, e só anuncia sucesso depois de
conferir com `sshd -T` que o servidor recusa senha. Se outro arquivo ainda
mandar mais alto, o script desfaz a mudança e avisa qual arquivo conferir, em
vez de dizer que deu certo.

**Quem já rodou a 1.17.0 com `--ssh-so-chave`:** rode de novo
`bash hostgator-setup-kit/preparar-host.sh --ssh-so-chave` depois de atualizar.
Para conferir agora, sem atualizar: `sshd -T | grep passwordauthentication`
precisa responder `no`.
