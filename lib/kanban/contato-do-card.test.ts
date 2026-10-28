import { describe, expect, it } from "vitest";

import { contatoDoCard, type LinhaDeContato } from "./contato-do-card";

const linha = (over: Partial<LinhaDeContato> = {}): LinhaDeContato => ({
  id: "ct-1",
  display_name: "Maria Souza",
  name: "Maria",
  phone_number: "+5511999990000",
  avatar_storage_path: "org/ct-1/avatar.jpg",
  is_anonymized: false,
  ...over,
});

describe("contatoDoCard — o que o card sabe do cliente", () => {
  it("contato comum sai inteiro: nome, telefone e o caminho da foto", () => {
    expect(contatoDoCard(linha())).toEqual({
      id: "ct-1",
      display_name: "Maria Souza",
      name: "Maria",
      phone_number: "+5511999990000",
      avatar_storage_path: "org/ct-1/avatar.jpg",
      is_anonymized: false,
    });
  });

  it("contato ANONIMIZADO sai sem nome, sem telefone e sem foto — o dado nem chega ao navegador", () => {
    const c = contatoDoCard(linha({ is_anonymized: true }));
    expect(c.is_anonymized).toBe(true);
    expect(c.display_name).toBeNull();
    expect(c.name).toBeNull();
    expect(c.phone_number).toBeNull();
    expect(c.avatar_storage_path).toBeNull();
    // O id fica: é com ele que o card se liga ao resto (e ele não identifica ninguém).
    expect(c.id).toBe("ct-1");
  });

  it("is_anonymized nulo NÃO é anonimizado — não se apaga o nome de quem nunca pediu isso", () => {
    const c = contatoDoCard(linha({ is_anonymized: null }));
    expect(c.is_anonymized).toBe(false);
    expect(c.display_name).toBe("Maria Souza");
    expect(c.avatar_storage_path).toBe("org/ct-1/avatar.jpg");
  });

  it("contato sem foto continua sem foto (o card cai nas iniciais)", () => {
    expect(contatoDoCard(linha({ avatar_storage_path: null })).avatar_storage_path).toBeNull();
  });
});
