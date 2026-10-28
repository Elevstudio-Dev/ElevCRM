import QRCode from "qrcode";

const OPCOES = { margin: 2, errorCorrectionLevel: "M" as const };

function salvar(url: string, nome: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** PNG de 1024 px: grande o bastante para imprimir em cartaz sem serrilhado. */
export async function baixarPng(link: string, codigo: string): Promise<void> {
  const url = await QRCode.toDataURL(link, { ...OPCOES, width: 1024 });
  salvar(url, `qr-${codigo}.png`);
}

/** SVG: vetorial, para a gráfica ampliar sem perder nitidez. */
export async function baixarSvg(link: string, codigo: string): Promise<void> {
  const svg = await QRCode.toString(link, { ...OPCOES, type: "svg" });
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  salvar(url, `qr-${codigo}.svg`);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
