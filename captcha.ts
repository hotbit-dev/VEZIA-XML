// Leitor local do captcha do PJe-JT — tudo roda no computador do escritório, sem serviço externo.
// Calibração por variáveis de ambiente (ou no arquivo veziadv-agente.json, chave "captcha"):
//   CAPTCHA_ETAPAS   etapas ligadas, em ordem (padrão: cinza,ampliar,contraste,binarizar,mediana,borda)
//   CAPTCHA_MANCHA   apaga manchas pretas menores que N pixels (padrão 60)
//   CAPTCHA_LIMIAR   0-255 fixo; vazio = automático (Otsu)
//   CAPTCHA_ESCALA   ampliação (padrão 3)
//   CAPTCHA_PSM      7 = uma linha (padrão) ou 8 = uma palavra
//   CAPTCHA_CHARS    caracteres permitidos (padrão letras minúsculas + números)
//   CAPTCHA_TAMANHO  quantidade esperada de caracteres; vazio = não verifica
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Px = { w: number; h: number; d: Uint8Array }; // imagem em tons de cinza, 1 byte por pixel

const env = (k: string, p = "") => (process.env[k] ?? p).trim();
export const configCaptcha = () => ({
  etapas: env("CAPTCHA_ETAPAS", "cinza,ampliar,contraste,binarizar,mediana,manchas,borda").split(",").map((s) => s.trim()).filter(Boolean),
  limiar: env("CAPTCHA_LIMIAR") ? Number(env("CAPTCHA_LIMIAR")) : null,
  escala: Number(env("CAPTCHA_ESCALA", "3")) || 3,
  psm: env("CAPTCHA_PSM", "7"),
  chars: env("CAPTCHA_CHARS", "abcdefghijklmnopqrstuvwxyz0123456789"),
  mancha: Number(env("CAPTCHA_MANCHA", "60")) || 0,
  tamanho: env("CAPTCHA_TAMANHO", "6") ? Number(env("CAPTCHA_TAMANHO", "6")) : null, // PJe usa sempre 6
});

// 1) Escala de cinza: remove a cor do fundo (luminância ponderada do olho humano).
function cinza(rgba: Uint8Array, w: number, h: number): Px {
  const d = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255; // transparente vira branco
    const l = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    d[i] = Math.round(l * a + 255 * (1 - a));
  }
  return { w, h, d };
}

// 2) Ampliar Nx com Lanczos (a=3): o captcha tem ~120x40 px e o OCR erra traços finos.
function lanczos(x: number) { if (x === 0) return 1; if (Math.abs(x) >= 3) return 0; const p = Math.PI * x; return (3 * Math.sin(p) * Math.sin(p / 3)) / (p * p); }
function ampliar(img: Px, k: number): Px {
  const W = Math.round(img.w * k), H = Math.round(img.h * k);
  // separável: primeiro horizontal, depois vertical
  const tmp = new Float32Array(W * img.h);
  for (let y = 0; y < img.h; y++) for (let X = 0; X < W; X++) {
    const sx = (X + 0.5) / k - 0.5; let s = 0, ws = 0;
    for (let i = Math.floor(sx) - 2; i <= Math.floor(sx) + 3; i++) { const wt = lanczos(sx - i); s += wt * img.d[y * img.w + Math.min(img.w - 1, Math.max(0, i))]; ws += wt; }
    tmp[y * W + X] = s / ws;
  }
  const d = new Uint8Array(W * H);
  for (let Y = 0; Y < H; Y++) { const sy = (Y + 0.5) / k - 0.5; for (let X = 0; X < W; X++) {
    let s = 0, ws = 0;
    for (let j = Math.floor(sy) - 2; j <= Math.floor(sy) + 3; j++) { const wt = lanczos(sy - j); s += wt * tmp[Math.min(img.h - 1, Math.max(0, j)) * W + X]; ws += wt; }
    d[Y * W + X] = Math.max(0, Math.min(255, Math.round(s / ws)));
  } }
  return { w: W, h: H, d };
}

// 3) Contraste: estica o histograma (ignora 1% dos extremos) para o preto ficar preto e o branco, branco.
function contraste(img: Px): Px {
  const hist = new Array(256).fill(0); img.d.forEach((v) => hist[v]++);
  const corte = img.d.length * 0.01; let lo = 0, hi = 255, acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < corte; lo++); acc = 0;
  for (; hi > 0 && (acc += hist[hi]) < corte; hi--);
  if (hi <= lo) return img;
  const d = img.d.map((v) => Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / (hi - lo)))));
  return { ...img, d };
}

// 4) Binarizar: preto e branco puro. Otsu escolhe sozinho o limiar que melhor separa letra e fundo.
export function otsu(d: Uint8Array) {
  const hist = new Array(256).fill(0); d.forEach((v) => hist[v]++);
  let soma = 0; for (let i = 0; i < 256; i++) soma += i * hist[i];
  let sB = 0, wB = 0, melhor = 0, lim = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = d.length - wB; if (!wF) break;
    sB += t * hist[t]; const mB = sB / wB, mF = (soma - sB) / wF; const v = wB * wF * (mB - mF) ** 2;
    if (v > melhor) { melhor = v; lim = t; }
  }
  return lim;
}
function binarizar(img: Px, fixo: number | null): Px {
  const lim = fixo ?? otsu(img.d);
  let d = img.d.map((v) => (v > lim ? 255 : 0));
  // garante letra preta em fundo branco (o Tesseract espera assim)
  if (d.reduce((n, v) => n + (v ? 0 : 1), 0) > d.length / 2) d = d.map((v) => 255 - v);
  return { ...img, d };
}

// 5) Mediana 3x3: apaga pontinhos e riscos finos de interferência sem destruir as letras.
function mediana(img: Px): Px {
  const d = new Uint8Array(img.d.length); const v: number[] = [];
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    v.length = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) v.push(img.d[Math.min(img.h - 1, Math.max(0, y + j)) * img.w + Math.min(img.w - 1, Math.max(0, x + i))]);
    v.sort((a, b) => a - b); d[y * img.w + x] = v[4];
  }
  return { ...img, d };
}

// 5b) Manchas: apaga grupos de pixels pretos pequenos demais para serem letra (pontos que a mediana não pegou).
function manchas(img: Px, min: number): Px {
  if (!min) return img; const d = Uint8Array.from(img.d); const visto = new Uint8Array(d.length); const pilha: number[] = [];
  for (let i = 0; i < d.length; i++) {
    if (d[i] || visto[i]) continue; const grupo: number[] = []; pilha.push(i); visto[i] = 1;
    while (pilha.length) { const k = pilha.pop()!; grupo.push(k); const x = k % img.w, y = (k / img.w) | 0;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= img.w || ny >= img.h) continue; const n = ny * img.w + nx; if (!d[n] && !visto[n]) { visto[n] = 1; pilha.push(n); } } }
    if (grupo.length < min) for (const k of grupo) d[k] = 255;
  }
  return { ...img, d };
}

// 6) Borda branca de 10 px: o Tesseract lê melhor com margem em volta do texto.
function borda(img: Px, m = 10): Px {
  const w = img.w + 2 * m, h = img.h + 2 * m; const d = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < img.h; y++) d.set(img.d.subarray(y * img.w, (y + 1) * img.w), (y + m) * w + m);
  return { w, h, d };
}

async function decodificar(buf: Buffer) {
  const { PNG } = await import("pngjs");
  if (buf[0] === 0x89) { const p = PNG.sync.read(buf); return cinza(new Uint8Array(p.data), p.width, p.height); }
  const jpeg = await import("jpeg-js"); const j = jpeg.decode(buf, { useTArray: true });
  return cinza(j.data, j.width, j.height);
}
async function codificar(img: Px) {
  const { PNG } = await import("pngjs"); const p = new PNG({ width: img.w, height: img.h });
  for (let i = 0; i < img.d.length; i++) { p.data[i * 4] = p.data[i * 4 + 1] = p.data[i * 4 + 2] = img.d[i]; p.data[i * 4 + 3] = 255; }
  return PNG.sync.write(p);
}

/** Aplica as etapas ligadas na configuração, na ordem indicada. */
export async function tratar(buf: Buffer) {
  const c = configCaptcha(); let img = await decodificar(buf); // decodificar já entrega em cinza
  for (const e of c.etapas) {
    // O TRT já manda ~920x290: ampliar de novo deforma as letras. Só amplia imagem pequena.
    if (e === "ampliar") { if (img.w < 300) img = ampliar(img, c.escala); }
    else if (e === "contraste") img = contraste(img);
    else if (e === "binarizar") img = binarizar(img, c.limiar);
    else if (e === "mediana") img = mediana(img);
    else if (e === "manchas") img = manchas(img, Math.round(c.mancha * Math.min(1, img.w / 900)) || c.mancha);
    else if (e === "borda") img = borda(img);
  }
  return codificar(img);
}

// ---------- Amostras e estatística ----------
let seq = 0;
export const stats = { total: 0, aceitos: 0, rejeitados: 0, descartados: 0, ia: 0 };
export function zerarStats() { Object.assign(stats, { total: 0, aceitos: 0, rejeitados: 0, descartados: 0, ia: 0 }); }
const p2 = (n: number) => String(n).padStart(2, "0");
export function salvarAmostra(pasta: string, raw: Buffer, tratada: Buffer) {
  const raiz = join(pasta, "captchas"); for (const s of ["raw", "processed"]) mkdirSync(join(raiz, s), { recursive: true });
  const t = new Date(); const nome = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}-${++seq}.png`;
  writeFileSync(join(raiz, "raw", nome), raw); writeFileSync(join(raiz, "processed", nome), tratada);
  return nome;
}
export function registrarCsv(pasta: string, arquivo: string, texto: string, aceito: boolean | "descartado", tentativa: number) {
  const f = join(pasta, "captchas", "log.csv");
  if (!existsSync(f)) writeFileSync(f, "arquivo,texto_lido_pelo_ocr,aceito_pelo_trt,tentativa\n");
  appendFileSync(f, `${arquivo},${texto},${aceito},${tentativa}\n`);
}

// ---------- OCR ----------
let ocr: Promise<{ recognize: (img: Buffer) => Promise<{ data: { text: string } }> }> | null = null;
export async function lerTexto(img: Buffer, aoPreparar: () => void) {
  ocr ??= (async () => {
    aoPreparar(); const c = configCaptcha(); const T = await import("tesseract.js");
    const w = await T.createWorker("eng", 1 /* OEM 1 = LSTM */);
    await w.setParameters({ tessedit_char_whitelist: c.chars, tessedit_pageseg_mode: c.psm as never });
    return w;
  })();
  const r = await (await ocr).recognize(img);
  const permitidos = new Set(configCaptcha().chars);
  return [...r.data.text].filter((ch) => permitidos.has(ch)).join("");
}
