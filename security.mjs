// Autenticação e limites do bridge — funções puras, testadas em src/test/bridge-security.test.ts.
import crypto from "node:crypto";

export const MAX_BODY_BYTES = 2_000_000; // .pfx em base64 (~1,5 MB no máximo) + campos
export const MAX_SKEW_SECONDS = 60;

const sha256 = (v) => crypto.createHash("sha256").update(v).digest();

/** Compara Bearer em tempo constante sobre hashes SHA-256 (tamanho fixo de 32 bytes). */
export function bearerOk(header, token) {
  return crypto.timingSafeEqual(sha256(String(header ?? "")), sha256(`Bearer ${token}`));
}

/** Cache de nonces vistos dentro da janela; recusa repetição (anti-replay). */
export function createNonceStore(maxEntries = 50_000) {
  const seen = new Map();
  return {
    use(nonce, nowSec) {
      for (const [n, exp] of seen) { if (exp > nowSec) break; seen.delete(n); }
      if (seen.has(nonce)) return false;
      if (seen.size >= maxEntries) return false; // sob ataque, falha fechado
      seen.set(nonce, nowSec + MAX_SKEW_SECONDS * 2);
      return true;
    },
    size: () => seen.size,
  };
}

/** Verifica HMAC-SHA256("ts.nonce.MÉTODO.caminho.sha256hex(corpo)") com token como chave. */
export function verifySignature({ token, method, path, rawBody, headers, nonces, nowSec = Math.floor(Date.now() / 1000) }) {
  const ts = String(headers["x-bridge-timestamp"] ?? "");
  const nonce = String(headers["x-bridge-nonce"] ?? "");
  const sig = String(headers["x-bridge-signature"] ?? "");
  if (!/^\d{9,11}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return "assinatura ausente";
  if (Math.abs(nowSec - Number(ts)) > MAX_SKEW_SECONDS) return "assinatura expirada";
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const expected = crypto.createHmac("sha256", token).update(`${ts}.${nonce}.${method}.${path}.${bodyHash}`).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(sig, "hex"))) return "assinatura inválida";
  if (!nonces.use(nonce, nowSec)) return "requisição repetida";
  return null;
}

/** Janela fixa por chave (IP): até `limit` requisições a cada `windowMs`. */
export function createRateLimiter({ limit = 60, windowMs = 60_000, maxKeys = 10_000 } = {}) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    let e = hits.get(key);
    if (!e || now - e.start >= windowMs) {
      if (!e && hits.size >= maxKeys) for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
      e = { start: now, count: 0 };
      hits.set(key, e);
    }
    e.count += 1;
    return e.count <= limit;
  };
}

/** Lê o corpo cru com teto, abortando assim que exceder (não acumula além do limite). */
export async function readRawBody(req, max = MAX_BODY_BYTES) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) throw Object.assign(new Error("payload grande demais"), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error("payload grande demais"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Zera buffers com material sensível após o uso. Strings JS não podem ser zeradas. */
export function wipe(...buffers) {
  for (const b of buffers) if (b && typeof b.fill === "function") b.fill(0);
}

/** Mesma regra de src/lib/safe-xml.ts: remove BOM/NUL e recusa DTD/entidades, sem diferenciar caixa. */
export function assertSafeXml(xml) {
  const t = String(xml ?? "").replace(/^\uFEFF/, "").replace(/\u0000/g, "");
  if (/<!\s*(DOCTYPE|ENTITY|ATTLIST|ELEMENT|NOTATION)\b/i.test(t)) throw new Error("Resposta XML SEFAZ inválida.");
  return t;
}
